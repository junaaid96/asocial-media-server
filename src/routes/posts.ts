import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { decodeCursor, pageLimit } from "../lib/cursor.js";
import { HttpError, forbidden, idParam, notFound, param, parse } from "../lib/http.js";
import {
  MOODS,
  REACTIONS,
  VISIBILITIES,
  fetchPost,
  fetchPosts,
  fetchResonating,
  notifyMentions,
  syncTags,
  visibleCounts,
  visiblePost,
} from "../lib/posts.js";
import { promptFor } from "../lib/prompts.js";
import { sanitizeRichText } from "../lib/richtext.js";
import { publicUser } from "../lib/users.js";
import { deleteObject, ownsKey } from "../storage.js";

export const router = Router();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date").refine((d) => !Number.isNaN(Date.parse(d)), "Invalid date");

const feedQuery = z.object({
  feed: z.enum(["latest", "following", "prompt"]).default("latest"),
  mood: z.enum(MOODS).optional(),
  tag: z
    .string()
    .trim()
    .transform((t) => t.replace(/^#/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9_]{1,50}$/, "Invalid hashtag"))
    .optional(),
  promptDate: dateString.optional(),
});

router.get("/posts", async (req, res) => {
  const { feed, mood, tag, promptDate } = parse(feedQuery, req.query);
  if (feed === "following" && !req.userId) throw new HttpError(401, "Sign in to see people you follow");
  const page = await fetchPosts({
    viewerId: req.userId,
    cursor: decodeCursor(req.query.cursor),
    limit: pageLimit(req.query.limit),
    where: (p) => {
      const conditions: string[] = [];
      if (feed === "following") {
        conditions.push(
          `(p.author_id = $1::uuid OR (NOT p.is_anonymous AND p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1::uuid)))`,
        );
      }
      if (feed === "prompt") conditions.push(`p.prompt_date = ${p.add(promptFor().date)}::date`);
      if (promptDate) conditions.push(`p.prompt_date = ${p.add(promptDate)}::date`);
      if (mood) conditions.push(`p.mood = ${p.add(mood)}`);
      if (tag) conditions.push(`EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ${p.add(tag)})`);
      return conditions;
    },
  });
  res.json(page);
});

router.get("/posts/resonating", async (req, res) => {
  res.json({ items: await fetchResonating(req.userId) });
});

async function promptWithAnswers(date: string) {
  const prompt = promptFor(new Date(`${date}T00:00:00Z`));
  // Public answers only, so the number never hints at private posts.
  const [row] = await db.query<{ answers: number }>(
    `SELECT count(*)::int AS answers FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.prompt_date = $1::date AND p.visibility = 'public' AND p.hidden_at IS NULL AND u.suspended_at IS NULL`,
    [prompt.date],
  );
  return { ...prompt, answers: row?.answers ?? 0 };
}

router.get("/prompt", async (_req, res) => {
  res.json(await promptWithAnswers(promptFor().date));
});

router.get("/prompts/:date", async (req, res) => {
  const date = parse(dateString, param(req, "date"));
  if (date > promptFor().date) throw notFound("That prompt hasn't been asked yet");
  res.json(await promptWithAnswers(date));
});

// Hashtags used most in public posts over the last two weeks.
router.get("/tags/trending", async (_req, res) => {
  const rows = await db.query<{ tag: string; posts: number }>(
    `SELECT t.tag, count(*)::int AS posts
     FROM post_tags t JOIN posts p ON p.id = t.post_id JOIN users u ON u.id = p.author_id
     WHERE p.created_at > now() - interval '14 days' AND p.visibility = 'public' AND p.hidden_at IS NULL AND u.suspended_at IS NULL
     GROUP BY t.tag ORDER BY posts DESC, t.tag LIMIT 10`,
  );
  res.set("Cache-Control", "public, max-age=120");
  res.json({ items: rows });
});

router.get("/posts/:id", async (req, res) => {
  const post = await fetchPost(idParam(req), req.userId, { asModerator: req.role === "admin" && !req.suspended });
  if (!post) throw notFound("This post has drifted away");
  res.json({ post });
});

const richBody = (max: number) => z.string().max(max * 2).transform(sanitizeRichText).pipe(z.string().max(max));

const postSchema = z.object({
  body: richBody(3000).default(""),
  imageKey: z.string().max(200).nullable().optional(),
  mood: z.enum(MOODS).nullable().optional(),
  contentWarning: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((value) => value || null),
  isAnonymous: z.boolean().default(false),
  answersPrompt: z.boolean().default(false),
  visibility: z.enum(VISIBILITIES).default("public"),
});

router.post("/posts", requireAuth, async (req, res) => {
  const me = viewer(req);
  const input = parse(postSchema, req.body);
  if (!input.body && !input.imageKey) throw new HttpError(400, "Write something or add a photo");
  if (input.imageKey && !ownsKey(input.imageKey, "posts", me)) throw new HttpError(400, "Invalid image");
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO posts (author_id, body, image_key, mood, content_warning, is_anonymous, prompt_date, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      me,
      input.body,
      input.imageKey ?? null,
      input.mood ?? null,
      input.contentWarning,
      input.isAnonymous,
      input.answersPrompt ? promptFor().date : null,
      input.visibility,
    ],
  );
  await syncTags(row!.id, input.body);
  await notifyMentions({ postId: row!.id, actorId: me, anonymous: input.isAnonymous, body: input.body });
  res.status(201).json({ post: await fetchPost(row!.id, me) });
});

const editSchema = z.object({
  body: richBody(3000).optional(),
  mood: z.enum(MOODS).nullable().optional(),
  contentWarning: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
  visibility: z.enum(VISIBILITIES).optional(),
});

async function ownPost(id: string, me: string) {
  const post = await one<{ author_id: string; image_key: string | null; body: string; is_anonymous: boolean }>(
    "SELECT author_id, image_key, body, is_anonymous FROM posts WHERE id = $1",
    [id],
  );
  if (!post) throw notFound("This post has drifted away");
  if (post.author_id !== me) throw forbidden("Only the author can change this post");
  return post;
}

router.patch("/posts/:id", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const input = parse(editSchema, req.body);
  const post = await ownPost(id, me);
  const body = input.body ?? post.body;
  if (!body && !post.image_key) throw new HttpError(400, "A post needs words or a photo");
  await db.query(
    `UPDATE posts SET
       body = $2,
       mood = CASE WHEN $3::boolean THEN $4 ELSE mood END,
       content_warning = CASE WHEN $5::boolean THEN $6 ELSE content_warning END,
       visibility = coalesce($7, visibility),
       edited_at = CASE WHEN body IS DISTINCT FROM $2 OR $3::boolean OR $5::boolean THEN now() ELSE edited_at END
     WHERE id = $1`,
    [id, body, input.mood !== undefined, input.mood ?? null, input.contentWarning !== undefined, input.contentWarning ?? null, input.visibility ?? null],
  );
  if (input.body !== undefined) {
    await syncTags(id, body);
    await notifyMentions({ postId: id, actorId: me, anonymous: post.is_anonymous, body, previousBody: post.body });
  }
  res.json({ post: await fetchPost(id, me) });
});

router.delete("/posts/:id", requireAuth, async (req, res) => {
  const id = idParam(req);
  const post = await ownPost(id, viewer(req));
  await db.query("DELETE FROM posts WHERE id = $1", [id]);
  if (post.image_key) await deleteObject(post.image_key);
  res.status(204).end();
});

async function seePost(id: string, me: string | undefined) {
  const post = await visiblePost(id, me);
  if (!post) throw notFound("This post has drifted away");
  return post;
}

router.put("/posts/:id/reaction", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { kind } = parse(z.object({ kind: z.enum(REACTIONS) }), req.body);
  const post = await seePost(id, me);
  const [row] = await db.query<{ inserted: boolean }>(
    `INSERT INTO reactions (post_id, user_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (post_id, user_id) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING (xmax = 0) AS inserted`,
    [id, me, kind],
  );
  if (row?.inserted && post.author_id !== me) {
    await db.query(
      "INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, 'reaction', $3)",
      [post.author_id, me, id],
    );
  }
  res.json({ post: await fetchPost(id, me) });
});

router.delete("/posts/:id/reaction", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  await db.query("DELETE FROM reactions WHERE post_id = $1 AND user_id = $2", [id, me]);
  await db.query("DELETE FROM notifications WHERE type = 'reaction' AND post_id = $1 AND actor_id = $2", [id, me]);
  const post = await fetchPost(id, me);
  if (!post) throw notFound("This post has drifted away");
  res.json({ post });
});

router.post("/posts/:id/bookmark", requireAuth, async (req, res) => {
  const id = idParam(req);
  const me = viewer(req);
  await seePost(id, me);
  await db.query("INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [me, id]);
  res.json({ bookmarked: true });
});

router.delete("/posts/:id/bookmark", requireAuth, async (req, res) => {
  await db.query("DELETE FROM bookmarks WHERE user_id = $1 AND post_id = $2", [viewer(req), idParam(req)]);
  res.json({ bookmarked: false });
});

router.get("/bookmarks", requireAuth, async (req, res) => {
  const page = await fetchPosts({
    viewerId: viewer(req),
    cursor: decodeCursor(req.query.cursor),
    limit: pageLimit(req.query.limit),
    cursorColumn: "saved.created_at",
    join: () => "JOIN bookmarks saved ON saved.post_id = p.id AND saved.user_id = $1::uuid",
  });
  res.json(page);
});

// --- Comments ("replies") ---------------------------------------------------

interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  username: string;
  display_name: string;
  avatar_key: string | null;
  battery: string;
  show_counts: boolean;
  post_author_id: string;
  post_is_anonymous: boolean;
  my_reaction: string | null;
  reaction_counts: Record<string, number>;
}

function serializeComment(row: CommentRow, me: string | undefined) {
  // On an anonymous post, the author's own replies stay anonymous too.
  const isOriginalPoster = row.author_id === row.post_author_id;
  const hide = row.post_is_anonymous && isOriginalPoster && row.author_id !== me;
  const isMine = row.author_id === me;
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    isMine,
    isOriginalPoster,
    author: hide ? null : publicUser(row),
    myReaction: row.my_reaction,
    // Same quiet-count rule as posts. An anonymous author's opt-in isn't applied, so it can't identify them.
    ...visibleCounts(row.reaction_counts, isMine || (row.show_counts && !hide)),
  };
}

const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, c.edited_at,
         u.username, u.display_name, u.avatar_key, u.battery, u.show_counts,
         p.author_id AS post_author_id, p.is_anonymous AS post_is_anonymous,
         (SELECT cr.kind FROM comment_reactions cr WHERE cr.comment_id = c.id AND cr.user_id = $1::uuid) AS my_reaction,
         (SELECT coalesce(jsonb_object_agg(s.kind, s.n), '{}'::jsonb)
            FROM (SELECT cr.kind, count(*)::int AS n FROM comment_reactions cr WHERE cr.comment_id = c.id GROUP BY cr.kind) s
         ) AS reaction_counts
  FROM comments c
  JOIN users u ON u.id = c.author_id
  JOIN posts p ON p.id = c.post_id`;

async function fetchComment(id: string, me: string | undefined) {
  const [row] = await db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $2`, [me ?? null, id]);
  return row ? serializeComment(row, me) : undefined;
}

router.get("/posts/:id/comments", async (req, res) => {
  const id = idParam(req);
  await seePost(id, req.userId);
  const rows = await db.query<CommentRow>(
    `${COMMENT_SELECT} WHERE c.post_id = $2 AND (u.suspended_at IS NULL OR c.author_id = $1::uuid)
     ORDER BY c.created_at ASC LIMIT 500`,
    [req.userId ?? null, id],
  );
  res.json({ items: rows.map((row) => serializeComment(row, req.userId)) });
});

const commentSchema = z.object({ body: richBody(1000).pipe(z.string().min(1, "Write a reply first")) });

router.post("/posts/:id/comments", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { body } = parse(commentSchema, req.body);
  const post = await seePost(id, me);
  const [inserted] = await db.query<{ id: string }>(
    "INSERT INTO comments (post_id, author_id, body) VALUES ($1, $2, $3) RETURNING id",
    [id, me, body],
  );
  if (post.author_id !== me) {
    await db.query(
      "INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id) VALUES ($1, $2, 'comment', $3, $4)",
      [post.author_id, me, id, inserted!.id],
    );
  }
  // A post author replying on their own anonymous post stays anonymous in mentions too.
  await notifyMentions({ postId: id, commentId: inserted!.id, actorId: me, anonymous: post.is_anonymous && post.author_id === me, body });
  res.status(201).json({ comment: await fetchComment(inserted!.id, me) });
});

async function ownComment(id: string, me: string) {
  const comment = await one<{ author_id: string; body: string; post_id: string; is_anonymous: boolean; post_author_id: string }>(
    `SELECT c.author_id, c.body, c.post_id, p.is_anonymous, p.author_id AS post_author_id
     FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
    [id],
  );
  if (!comment) throw notFound("That reply no longer exists");
  if (comment.author_id !== me) throw forbidden("Only the author can change this reply");
  return comment;
}

router.patch("/comments/:id", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { body } = parse(commentSchema, req.body);
  const comment = await ownComment(id, me);
  await db.query("UPDATE comments SET body = $2, edited_at = now() WHERE id = $1", [id, body]);
  await notifyMentions({
    postId: comment.post_id,
    commentId: id,
    actorId: me,
    anonymous: comment.is_anonymous && comment.post_author_id === me,
    body,
    previousBody: comment.body,
  });
  res.json({ comment: await fetchComment(id, me) });
});

router.delete("/comments/:id", requireAuth, async (req, res) => {
  const id = idParam(req);
  await ownComment(id, viewer(req));
  await db.query("DELETE FROM comments WHERE id = $1", [id]);
  res.status(204).end();
});

async function seeComment(id: string, me: string) {
  const comment = await one<{ author_id: string; post_id: string }>("SELECT author_id, post_id FROM comments WHERE id = $1", [id]);
  if (!comment) throw notFound("That reply no longer exists");
  await seePost(comment.post_id, me);
  return comment;
}

router.put("/comments/:id/reaction", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { kind } = parse(z.object({ kind: z.enum(REACTIONS) }), req.body);
  const comment = await seeComment(id, me);
  const [row] = await db.query<{ inserted: boolean }>(
    `INSERT INTO comment_reactions (comment_id, user_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (comment_id, user_id) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING (xmax = 0) AS inserted`,
    [id, me, kind],
  );
  if (row?.inserted && comment.author_id !== me) {
    await db.query(
      "INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id) VALUES ($1, $2, 'comment_reaction', $3, $4)",
      [comment.author_id, me, comment.post_id, id],
    );
  }
  res.json({ comment: await fetchComment(id, me) });
});

router.delete("/comments/:id/reaction", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  await seeComment(id, me);
  await db.query("DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2", [id, me]);
  await db.query("DELETE FROM notifications WHERE type = 'comment_reaction' AND comment_id = $1 AND actor_id = $2", [id, me]);
  res.json({ comment: await fetchComment(id, me) });
});
