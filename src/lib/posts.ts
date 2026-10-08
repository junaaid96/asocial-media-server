import { db } from "../db.js";
import { fileUrl } from "../storage.js";
import { type Cursor, encodeCursor } from "./cursor.js";
import { promptFor } from "./prompts.js";
import { extractHashtags, extractMentions } from "./richtext.js";

export const MOODS = ["calm", "reflective", "joyful", "grateful", "tired", "anxious", "curious", "melancholy"] as const;
export const REACTIONS = ["felt", "hug", "insight", "relate"] as const;
export const VISIBILITIES = ["public", "followers", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface PostRow {
  id: string;
  author_id: string;
  body: string;
  image_key: string | null;
  mood: string | null;
  content_warning: string | null;
  is_anonymous: boolean;
  prompt_date: string | Date | null;
  visibility: Visibility;
  hidden_at: Date | null;
  created_at: Date;
  edited_at: Date | null;
  username: string;
  display_name: string;
  avatar_key: string | null;
  battery: string;
  show_counts: boolean;
  comment_count: number;
  my_reaction: string | null;
  bookmarked: boolean;
  reaction_counts: Record<string, number>;
}

/** Collects positional parameters while building a query. `$1` is always the viewer. */
export class Params {
  values: unknown[];
  constructor(viewerId: string | undefined) {
    this.values = [viewerId ?? null];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * SQL condition: may the viewer ($1) see post `p` written by user `u`?
 * Authors always see their own posts. Everyone else needs the post to be visible
 * (not hidden by moderators, author not suspended) and allowed by its privacy setting.
 */
export const VISIBLE_TO_VIEWER = `(
  p.author_id = $1::uuid OR (
    p.hidden_at IS NULL AND u.suspended_at IS NULL AND (
      p.visibility = 'public'
      OR (p.visibility = 'followers' AND EXISTS (
        SELECT 1 FROM follows vf WHERE vf.follower_id = $1::uuid AND vf.followee_id = p.author_id))
    )
  )
)`;

const postSelect = (extraColumns = "") => `
  SELECT p.id, p.author_id, p.body, p.image_key, p.mood, p.content_warning, p.is_anonymous,
         to_char(p.prompt_date, 'YYYY-MM-DD') AS prompt_date, p.visibility, p.hidden_at, p.created_at, p.edited_at,
         u.username, u.display_name, u.avatar_key, u.battery, u.show_counts,
         (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count,
         (SELECT r.kind FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1::uuid) AS my_reaction,
         EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1::uuid) AS bookmarked,
         (SELECT coalesce(jsonb_object_agg(s.kind, s.n), '{}'::jsonb)
            FROM (SELECT r.kind, count(*)::int AS n FROM reactions r WHERE r.post_id = p.id GROUP BY r.kind) s
         ) AS reaction_counts${extraColumns}
  FROM posts p
  JOIN users u ON u.id = p.author_id`;

/** Quiet counts: totals are only visible to the author unless they opt in. */
export function visibleCounts(counts: Record<string, number> | null | undefined, canSee: boolean) {
  const safe = counts ?? {};
  return {
    reactionCounts: canSee ? safe : null,
    reactionTotal: canSee ? Object.values(safe).reduce((a, b) => a + b, 0) : null,
  };
}

function dateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export function serializePost(row: PostRow, viewerId: string | undefined) {
  const isMine = !!viewerId && row.author_id === viewerId;
  const hideAuthor = row.is_anonymous && !isMine;
  const promptDate = dateOnly(row.prompt_date);
  return {
    id: row.id,
    body: row.body,
    imageUrl: fileUrl(row.image_key),
    mood: row.mood,
    contentWarning: row.content_warning,
    isAnonymous: row.is_anonymous,
    promptDate,
    prompt: promptDate ? promptFor(new Date(`${promptDate}T00:00:00Z`)) : null,
    visibility: row.visibility,
    // Only the author learns that moderators hid a post.
    hiddenByModerators: isMine && !!row.hidden_at,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    author: hideAuthor
      ? null
      : {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: fileUrl(row.avatar_key),
          battery: row.battery,
        },
    isMine,
    myReaction: row.my_reaction,
    bookmarked: row.bookmarked,
    commentCount: row.comment_count,
    ...visibleCounts(row.reaction_counts, isMine || row.show_counts),
  };
}

export type PostDto = ReturnType<typeof serializePost>;

interface FetchOptions {
  viewerId: string | undefined;
  /** Returns SQL conditions (joined with AND). May register params. */
  where?: (params: Params) => string[];
  /** Extra JOIN clause, e.g. for bookmarks. */
  join?: (params: Params) => string;
  cursor?: Cursor;
  limit: number;
  /** Column pair used for keyset pagination. Defaults to the post's creation time. */
  cursorColumn?: string;
}

export async function fetchPosts(options: FetchOptions) {
  const params = new Params(options.viewerId);
  const column = options.cursorColumn ?? "p.created_at";
  const conditions = [VISIBLE_TO_VIEWER, ...(options.where?.(params) ?? [])];
  if (options.cursor) {
    conditions.push(`(${column}, p.id) < (${params.add(options.cursor.t)}::timestamptz, ${params.add(options.cursor.id)}::uuid)`);
  }
  const join = options.join?.(params) ?? "";
  const text = `
    ${postSelect(`, ${column} AS sort_key`)} ${join}
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${column} DESC, p.id DESC
    LIMIT ${params.add(options.limit + 1)}`;
  const rows = await db.query<PostRow & { sort_key: Date }>(text, params.values);
  const hasMore = rows.length > options.limit;
  const pageRows = rows.slice(0, options.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => serializePost(row, options.viewerId)),
    nextCursor: hasMore && last ? encodeCursor(last.sort_key, last.id) : null,
  };
}

/** A single post, if the viewer may see it. Moderators can open any post. */
export async function fetchPost(id: string, viewerId: string | undefined, { asModerator = false } = {}) {
  const rows = await db.query<PostRow>(`${postSelect()} WHERE p.id = $2 ${asModerator ? "" : `AND ${VISIBLE_TO_VIEWER}`}`, [
    viewerId ?? null,
    id,
  ]);
  return rows[0] ? serializePost(rows[0], viewerId) : undefined;
}

/** Author and anonymity of a post the viewer may see (or undefined). */
export async function visiblePost(id: string, viewerId: string | undefined) {
  const [row] = await db.query<{ author_id: string; is_anonymous: boolean; visibility: Visibility; body: string }>(
    `SELECT p.author_id, p.is_anonymous, p.visibility, p.body FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = $2 AND ${VISIBLE_TO_VIEWER}`,
    [viewerId ?? null, id],
  );
  return row;
}

/** Posts that quietly resonated this fortnight — ranked, but shown without numbers. Public posts only. */
export async function fetchResonating(viewerId: string | undefined, limit = 5) {
  const rows = await db.query<PostRow>(
    `${postSelect()}
     WHERE p.created_at > now() - interval '14 days'
       AND p.content_warning IS NULL
       AND p.visibility = 'public' AND p.hidden_at IS NULL AND u.suspended_at IS NULL
     ORDER BY (SELECT count(*) FROM reactions r WHERE r.post_id = p.id)
            + 2 * (SELECT count(*) FROM comments c WHERE c.post_id = p.id) DESC,
              p.created_at DESC
     LIMIT $2`,
    [viewerId ?? null, limit],
  );
  return rows.map((row) => serializePost(row, viewerId));
}

/** Replaces a post's hashtags with the ones in its body. */
export async function syncTags(postId: string, body: string) {
  const tags = extractHashtags(body);
  await db.query("DELETE FROM post_tags WHERE post_id = $1 AND NOT (tag = ANY($2::text[]))", [postId, tags]);
  if (tags.length) {
    await db.query("INSERT INTO post_tags (post_id, tag) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING", [postId, tags]);
  }
}

/**
 * Notifies people newly @mentioned in a post or reply. Only people who can see the post
 * are told; mentions in anonymous posts don't reveal who wrote them.
 */
export async function notifyMentions(options: {
  postId: string;
  commentId?: string;
  actorId: string;
  anonymous: boolean;
  body: string;
  previousBody?: string;
}) {
  const before = new Set(options.previousBody ? extractMentions(options.previousBody) : []);
  const usernames = extractMentions(options.body).filter((name) => !before.has(name));
  if (!usernames.length) return;
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id)
     SELECT u.id, $3::uuid, 'mention', $1::uuid, $4::uuid
     FROM users u
     JOIN posts p ON p.id = $1::uuid
     WHERE u.username = ANY($2::text[])
       AND u.id <> $5::uuid
       AND u.suspended_at IS NULL
       AND (p.author_id = u.id OR (
         p.hidden_at IS NULL AND (
           p.visibility = 'public'
           OR (p.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.followee_id = p.author_id)))))`,
    [options.postId, usernames, options.anonymous ? null : options.actorId, options.commentId ?? null, options.actorId],
  );
}
