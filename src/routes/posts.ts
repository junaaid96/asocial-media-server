import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { decodeCursor, pageLimit } from "../lib/cursor.js";
import { HttpError, forbidden, idParam, notFound, parse } from "../lib/http.js";
import { MOODS, REACTIONS, fetchPost, fetchPosts, fetchResonating } from "../lib/posts.js";
import { promptFor } from "../lib/prompts.js";
import { publicUser } from "../lib/users.js";
import { deleteObject, ownsKey } from "../storage.js";

export const router = Router();

const feedQuery = z.object({
  feed: z.enum(["latest", "following", "prompt"]).default("latest"),
  mood: z.enum(MOODS).optional(),
});

router.get("/posts", async (req, res) => {
  const { feed, mood } = parse(feedQuery, req.query);
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
      if (mood) conditions.push(`p.mood = ${p.add(mood)}`);
      return conditions;
    },
  });
  res.json(page);
});

router.get("/posts/resonating", async (req, res) => {
  res.json({ items: await fetchResonating(req.userId) });
});

router.get("/prompt", async (_req, res) => {
  const prompt = promptFor();
  const [row] = await db.query<{ answers: number }>(
    "SELECT count(*)::int AS answers FROM posts WHERE prompt_date = $1::date",
    [prompt.date],
  );
  res.json({ ...prompt, answers: row?.answers ?? 0 });
});

router.get("/posts/:id", async (req, res) => {
  const post = await fetchPost(idParam(req), req.userId);
  if (!post) throw notFound("This post has drifted away");
  res.json({ post });
});

const postSchema = z.object({
  body: z.string().trim().max(3000).default(""),
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
});

router.post("/posts", requireAuth, async (req, res) => {
  const me = viewer(req);
  const input = parse(postSchema, req.body);
  if (!input.body && !input.imageKey) throw new HttpError(400, "Write something or add a photo");
  if (input.imageKey && !ownsKey(input.imageKey, "posts", me)) throw new HttpError(400, "Invalid image");
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO posts (author_id, body, image_key, mood, content_warning, is_anonymous, prompt_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      me,
      input.body,
      input.imageKey ?? null,
      input.mood ?? null,
      input.contentWarning,
      input.isAnonymous,
      input.answersPrompt ? promptFor().date : null,
    ],
  );
  res.status(201).json({ post: await fetchPost(row!.id, me) });
});

const editSchema = z.object({
  body: z.string().trim().max(3000).optional(),
  mood: z.enum(MOODS).nullable().optional(),
  contentWarning: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
});

async function ownPost(id: string, me: string) {
  const post = await one<{ author_id: string; image_key: string | null; body: string }>(
    "SELECT author_id, image_key, body FROM posts WHERE id = $1",
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
       edited_at = now()
     WHERE id = $1`,
    [id, body, input.mood !== undefined, input.mood ?? null, input.contentWarning !== undefined, input.contentWarning ?? null],
  );
  res.json({ post: await fetchPost(id, me) });
});

router.delete("/posts/:id", requireAuth, async (req, res) => {
  const id = idParam(req);
  const post = await ownPost(id, viewer(req));
  await db.query("DELETE FROM posts WHERE id = $1", [id]);
  if (post.image_key) await deleteObject(post.image_key);
  res.status(204).end();
});

async function postAuthor(id: string) {
  const post = await one<{ author_id: string; is_anonymous: boolean }>(
    "SELECT author_id, is_anonymous FROM posts WHERE id = $1",
    [id],
  );
  if (!post) throw notFound("This post has drifted away");
  return post;
}

router.put("/posts/:id/reaction", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { kind } = parse(z.object({ kind: z.enum(REACTIONS) }), req.body);
  const post = await postAuthor(id);
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
  res.json({ post: await fetchPost(id, me) });
});

router.post("/posts/:id/bookmark", requireAuth, async (req, res) => {
  const id = idParam(req);
  await postAuthor(id);
  await db.query("INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [viewer(req), id]);
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
  post_author_id: string;
  post_is_anonymous: boolean;
}

function serializeComment(row: CommentRow, me: string | undefined) {
  // On an anonymous post, the author's own replies stay anonymous too.
  const isOriginalPoster = row.author_id === row.post_author_id;
  const hide = row.post_is_anonymous && isOriginalPoster && row.author_id !== me;
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    isMine: row.author_id === me,
    isOriginalPoster,
    author: hide ? null : publicUser(row),
  };
}

const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, c.edited_at,
         u.username, u.display_name, u.avatar_key, u.battery,
         p.author_id AS post_author_id, p.is_anonymous AS post_is_anonymous
  FROM comments c
  JOIN users u ON u.id = c.author_id
  JOIN posts p ON p.id = c.post_id`;

router.get("/posts/:id/comments", async (req, res) => {
  const rows = await db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 500`, [
    idParam(req),
  ]);
  res.json({ items: rows.map((row) => serializeComment(row, req.userId)) });
});

const commentSchema = z.object({ body: z.string().trim().min(1, "Write a reply first").max(1000) });

router.post("/posts/:id/comments", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { body } = parse(commentSchema, req.body);
  const post = await postAuthor(id);
  const [inserted] = await db.query<{ id: string }>(
    "INSERT INTO comments (post_id, author_id, body) VALUES ($1, $2, $3) RETURNING id",
    [id, me, body],
  );
  if (post.author_id !== me) {
    await db.query(
      "INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, 'comment', $3)",
      [post.author_id, me, id],
    );
  }
  const [row] = await db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted!.id]);
  res.status(201).json({ comment: serializeComment(row!, me) });
});

async function ownComment(id: string, me: string) {
  const comment = await one<{ author_id: string }>("SELECT author_id FROM comments WHERE id = $1", [id]);
  if (!comment) throw notFound("That reply no longer exists");
  if (comment.author_id !== me) throw forbidden("Only the author can change this reply");
}

router.patch("/comments/:id", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { body } = parse(commentSchema, req.body);
  await ownComment(id, me);
  await db.query("UPDATE comments SET body = $2, edited_at = now() WHERE id = $1", [id, body]);
  const [row] = await db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [id]);
  res.json({ comment: serializeComment(row!, me) });
});

router.delete("/comments/:id", requireAuth, async (req, res) => {
  const id = idParam(req);
  await ownComment(id, viewer(req));
  await db.query("DELETE FROM comments WHERE id = $1", [id]);
  res.status(204).end();
});
