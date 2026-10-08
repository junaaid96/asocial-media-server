import bcrypt from "bcryptjs";
import { type Request, Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { decodeCursor, pageLimit } from "../lib/cursor.js";
import { HttpError, notFound, param, parse } from "../lib/http.js";
import { VISIBLE_TO_VIEWER, fetchPosts } from "../lib/posts.js";
import { isOnline } from "../realtime.js";
import { USER_COLUMNS, type UserRow, profileUser, publicUser, selfUser } from "../lib/users.js";
import { deleteObject, ownsKey } from "../storage.js";
import { usernameSchema } from "./auth.js";

export const router = Router();

/** Finds a profile. Suspended accounts are only visible to themselves and moderators. */
async function findUser(username: string, req?: Request) {
  const user = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [username.toLowerCase().replace(/^@/, "")]);
  if (!user) throw notFound("We couldn't find that person");
  if (user.suspended_at && req?.userId !== user.id && req?.role !== "admin") throw notFound("We couldn't find that person");
  return user;
}

// Public community stats for the home page.
router.get("/stats", async (_req, res) => {
  const [row] = await db.query<{ users: number }>("SELECT count(*)::int AS users FROM users");
  res.set("Cache-Control", "public, max-age=60");
  res.json({ users: row!.users });
});

// "Kindred spirits": people who write in the same moods you do, and whom you don't follow yet.
router.get("/users/suggested", requireAuth, async (req, res) => {
  const me = viewer(req);
  const rows = await db.query<UserRow & { score: number }>(
    `WITH my_moods AS (
       SELECT DISTINCT mood FROM posts WHERE author_id = $1 AND mood IS NOT NULL
     ), candidates AS (
       SELECT u.id, count(p.id) FILTER (WHERE p.mood IN (SELECT mood FROM my_moods)) AS shared,
              max(p.created_at) AS last_post
       FROM users u
       LEFT JOIN posts p ON p.author_id = u.id AND NOT p.is_anonymous
       WHERE u.id <> $1 AND u.suspended_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id)
       GROUP BY u.id
     )
     SELECT u.username, u.display_name, u.avatar_key, u.battery, u.bio, c.shared::int AS score
     FROM candidates c JOIN users u ON u.id = c.id
     ORDER BY c.shared DESC, c.last_post DESC NULLS LAST, u.created_at DESC
     LIMIT 5`,
    [me],
  );
  res.json({
    items: rows.map((row) => ({ ...publicUser(row), bio: row.bio, sharedMoods: row.score > 0 })),
  });
});

// @mention autocomplete: prefix match on username or display name, people you follow first.
router.get("/users/lookup", async (req, res) => {
  const q = String(req.query.q ?? "").trim().replace(/^@/, "").toLowerCase().slice(0, 24);
  if (!q) return res.json({ items: [] });
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.query<UserRow>(
    `SELECT u.username, u.display_name, u.avatar_key, u.battery
     FROM users u
     WHERE u.suspended_at IS NULL AND (u.username LIKE $1 OR lower(u.display_name) LIKE $1 OR lower(u.display_name) LIKE '% ' || $1)
     ORDER BY EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2::uuid AND f.followee_id = u.id) DESC,
              (u.username LIKE $1) DESC, length(u.username), u.username
     LIMIT 6`,
    [prefix, req.userId ?? null],
  );
  res.json({ items: rows.map(publicUser) });
});

router.get("/users/:username", async (req, res) => {
  const user = await findUser(param(req, "username"), req);
  const me = req.userId;
  const [stats] = await db.query<{
    posts: number;
    followers: number;
    following: number;
    is_following: boolean;
    follows_me: boolean;
  }>(
    `SELECT
       (SELECT count(*)::int FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id = $1 AND (NOT p.is_anonymous OR p.author_id = $2::uuid)
           AND ${VISIBLE_TO_VIEWER.replaceAll("$1::uuid", "$2::uuid")}) AS posts,
       (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers,
       (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $2::uuid AND followee_id = $1) AS is_following,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2::uuid) AS follows_me`,
    [user.id, me ?? null],
  );
  const isMe = me === user.id;
  const online = isOnline(user.id);
  // Same rule as letters: who may start a conversation with this person.
  const canMessage =
    !!me && !isMe && !user.suspended_at && (user.letters_from === "everyone" || (user.letters_from === "following" && stats!.follows_me));
  res.json({
    user: { ...profileUser(user), online, lastSeenAt: online ? null : user.last_seen_at },
    isMe,
    canMessage,
    suspended: !!user.suspended_at,
    isFollowing: stats!.is_following,
    followsMe: stats!.follows_me,
    // Follower counts stay private: only you can see your own.
    stats: { posts: stats!.posts, followers: isMe ? stats!.followers : null, following: isMe ? stats!.following : null },
  });
});

router.get("/users/:username/posts", async (req, res) => {
  const user = await findUser(param(req, "username"), req);
  const me = req.userId;
  const page = await fetchPosts({
    viewerId: me,
    cursor: decodeCursor(req.query.cursor),
    limit: pageLimit(req.query.limit),
    where: (p) => {
      const conditions = [`p.author_id = ${p.add(user.id)}`];
      // Anonymous posts never show up on a profile, except to their author.
      if (me !== user.id) conditions.push("NOT p.is_anonymous");
      return conditions;
    },
  });
  res.json(page);
});

router.post("/users/:username/follow", requireAuth, async (req, res) => {
  const me = viewer(req);
  const user = await findUser(param(req, "username"));
  if (user.id === me) throw new HttpError(400, "You can't follow yourself");
  const inserted = await db.query(
    "INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1",
    [me, user.id],
  );
  if (inserted.length) {
    await db.query("INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, 'follow')", [user.id, me]);
  }
  res.json({ following: true });
});

router.delete("/users/:username/follow", requireAuth, async (req, res) => {
  const user = await findUser(param(req, "username"));
  await db.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [viewer(req), user.id]);
  res.json({ following: false });
});

router.get("/users/:username/connections", requireAuth, async (req, res) => {
  const user = await findUser(param(req, "username"));
  if (user.id !== viewer(req)) throw new HttpError(403, "Connections are private");
  const kind = req.query.kind === "following" ? "following" : "followers";
  const rows = await db.query<UserRow>(
    kind === "followers"
      ? `SELECT u.username, u.display_name, u.avatar_key, u.battery, u.bio FROM follows f JOIN users u ON u.id = f.follower_id
         WHERE f.followee_id = $1 ORDER BY f.created_at DESC LIMIT 200`
      : `SELECT u.username, u.display_name, u.avatar_key, u.battery, u.bio FROM follows f JOIN users u ON u.id = f.followee_id
         WHERE f.follower_id = $1 ORDER BY f.created_at DESC LIMIT 200`,
    [user.id],
  );
  res.json({ items: rows.map((row) => ({ ...publicUser(row), bio: row.bio })) });
});

const updateMeSchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(50),
    bio: z.string().trim().max(280),
    institute: z.string().trim().max(80),
    location: z.string().trim().max(80),
    avatarKey: z.string().max(200).nullable(),
    battery: z.enum(["full", "half", "low", "recharging"]),
    lettersFrom: z.enum(["everyone", "following", "nobody"]),
    showCounts: z.boolean(),
    dailyLimitMinutes: z.number().int().min(5).max(1440).nullable(),
  })
  .partial();

const COLUMN_FOR = {
  username: "username",
  displayName: "display_name",
  bio: "bio",
  institute: "institute",
  location: "location",
  avatarKey: "avatar_key",
  battery: "battery",
  lettersFrom: "letters_from",
  showCounts: "show_counts",
  dailyLimitMinutes: "daily_limit_minutes",
} as const;

router.patch("/me", requireAuth, async (req, res) => {
  const me = viewer(req);
  const input = parse(updateMeSchema, req.body);
  if (input.avatarKey && !ownsKey(input.avatarKey, "avatars", me)) throw new HttpError(400, "Invalid avatar");

  const current = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [me]);
  if (!current) throw new HttpError(401, "Please sign in again");

  if (input.username && input.username !== current.username) {
    const taken = await one("SELECT 1 FROM users WHERE username = $1", [input.username]);
    if (taken) throw new HttpError(409, "That username is taken");
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(COLUMN_FOR) as [keyof typeof COLUMN_FOR, string][]) {
    if (input[field] === undefined) continue;
    values.push(input[field]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return res.json({ user: selfUser(current) });

  values.push(me);
  const [user] = await db.query<UserRow>(
    `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${USER_COLUMNS}`,
    values,
  );
  if (input.avatarKey !== undefined && current.avatar_key && current.avatar_key !== input.avatarKey) {
    await deleteObject(current.avatar_key);
  }
  res.json({ user: selfUser(user!) });
});

// Mood garden: the moods you've written in over the last five weeks.
router.get("/me/moods", requireAuth, async (req, res) => {
  // Raw timestamps so the client can bucket posts by the viewer's local day.
  const rows = await db.query<{ created_at: Date; mood: string | null }>(
    `SELECT created_at, mood FROM posts
     WHERE author_id = $1 AND created_at > now() - interval '36 days'
     ORDER BY created_at LIMIT 1000`,
    [viewer(req)],
  );
  res.json({ items: rows.map((row) => ({ createdAt: row.created_at, mood: row.mood })) });
});

// --- Time well spent -------------------------------------------------------------
// The client reports active, visible time in small heartbeats; totals are kept per local day.

const usageSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seconds: z.number().int().min(1).max(120),
});

const usageBeats = new Map<string, number>();

router.post("/me/usage", requireAuth, async (req, res) => {
  const me = viewer(req);
  const { day, seconds } = parse(usageSchema, req.body);
  // The client's local day can differ from UTC by up to ±14 hours; anything else is bogus.
  const offsetDays = Math.abs(Date.parse(`${day}T12:00:00Z`) - Date.now()) / 86_400_000;
  if (!(offsetDays <= 1.5)) throw new HttpError(400, "That day is out of range");
  // One heartbeat counts at most once every 20 seconds, so a looping client can't inflate totals.
  const now = Date.now();
  if ((usageBeats.get(me) ?? 0) > now) return res.json({ counted: false });
  usageBeats.set(me, now + 20_000);
  if (usageBeats.size > 20_000) for (const [k, v] of usageBeats) if (v < now) usageBeats.delete(k);
  const [row] = await db.query<{ seconds: number }>(
    `INSERT INTO usage_days (user_id, day, seconds) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, day) DO UPDATE SET seconds = LEAST(usage_days.seconds + EXCLUDED.seconds, 86400)
     RETURNING seconds`,
    [me, day, seconds],
  );
  await db.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [me]);
  res.json({ counted: true, today: row!.seconds });
});

router.get("/me/usage", requireAuth, async (req, res) => {
  const me = viewer(req);
  const rows = await db.query<{ day: string; seconds: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, seconds FROM usage_days
     WHERE user_id = $1 AND day > (now() - interval '15 days')::date ORDER BY day`,
    [me],
  );
  const [user] = await db.query<{ daily_limit_minutes: number | null }>("SELECT daily_limit_minutes FROM users WHERE id = $1", [me]);
  res.json({ days: rows, dailyLimitMinutes: user?.daily_limit_minutes ?? null });
});

router.delete("/me", requireAuth, async (req, res) => {
  const me = viewer(req);
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
  const user = await one<{ password_hash: string; avatar_key: string | null }>(
    "SELECT password_hash, avatar_key FROM users WHERE id = $1",
    [me],
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new HttpError(403, "Password is incorrect");
  const images = await db.query<{ image_key: string }>(
    "SELECT image_key FROM posts WHERE author_id = $1 AND image_key IS NOT NULL",
    [me],
  );
  await db.query("DELETE FROM users WHERE id = $1", [me]);
  await Promise.all([...images.map((row) => row.image_key), user.avatar_key].filter((k): k is string => !!k).map(deleteObject));
  res.status(204).end();
});
