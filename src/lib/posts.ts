import { db } from "../db.js";
import { fileUrl } from "../storage.js";
import { type Cursor, encodeCursor } from "./cursor.js";

export const MOODS = ["calm", "reflective", "joyful", "grateful", "tired", "anxious", "curious", "melancholy"] as const;
export const REACTIONS = ["felt", "hug", "insight", "relate"] as const;

export interface PostRow {
  id: string;
  author_id: string;
  body: string;
  image_key: string | null;
  mood: string | null;
  content_warning: string | null;
  is_anonymous: boolean;
  prompt_date: string | Date | null;
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

const postSelect = (extraColumns = "") => `
  SELECT p.id, p.author_id, p.body, p.image_key, p.mood, p.content_warning, p.is_anonymous,
         p.prompt_date, p.created_at, p.edited_at,
         u.username, u.display_name, u.avatar_key, u.battery, u.show_counts,
         (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count,
         (SELECT r.kind FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1::uuid) AS my_reaction,
         EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1::uuid) AS bookmarked,
         (SELECT coalesce(jsonb_object_agg(s.kind, s.n), '{}'::jsonb)
            FROM (SELECT r.kind, count(*)::int AS n FROM reactions r WHERE r.post_id = p.id GROUP BY r.kind) s
         ) AS reaction_counts${extraColumns}
  FROM posts p
  JOIN users u ON u.id = p.author_id`;

export function serializePost(row: PostRow, viewerId: string | undefined) {
  const isMine = !!viewerId && row.author_id === viewerId;
  const hideAuthor = row.is_anonymous && !isMine;
  const counts = row.reaction_counts ?? {};
  return {
    id: row.id,
    body: row.body,
    imageUrl: fileUrl(row.image_key),
    mood: row.mood,
    contentWarning: row.content_warning,
    isAnonymous: row.is_anonymous,
    promptDate: row.prompt_date ? new Date(row.prompt_date).toISOString().slice(0, 10) : null,
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
    // Quiet counts: totals are only visible to the author unless they opt in.
    reactionCounts: isMine || row.show_counts ? counts : null,
    reactionTotal: isMine || row.show_counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null,
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
  const conditions = options.where?.(params) ?? [];
  if (options.cursor) {
    conditions.push(`(${column}, p.id) < (${params.add(options.cursor.t)}::timestamptz, ${params.add(options.cursor.id)}::uuid)`);
  }
  const join = options.join?.(params) ?? "";
  const text = `
    ${postSelect(`, ${column} AS sort_key`)} ${join}
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
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

export async function fetchPost(id: string, viewerId: string | undefined) {
  const rows = await db.query<PostRow>(`${postSelect()} WHERE p.id = $2`, [viewerId ?? null, id]);
  return rows[0] ? serializePost(rows[0], viewerId) : undefined;
}

/** Posts that quietly resonated this fortnight — ranked, but shown without numbers. */
export async function fetchResonating(viewerId: string | undefined, limit = 5) {
  const rows = await db.query<PostRow>(
    `${postSelect()}
     WHERE p.created_at > now() - interval '14 days'
       AND p.content_warning IS NULL
     ORDER BY (SELECT count(*) FROM reactions r WHERE r.post_id = p.id)
            + 2 * (SELECT count(*) FROM comments c WHERE c.post_id = p.id) DESC,
              p.created_at DESC
     LIMIT $2`,
    [viewerId ?? null, limit],
  );
  return rows.map((row) => serializePost(row, viewerId));
}
