import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { decodeCursor, pageLimit } from "../lib/cursor.js";
import { HttpError, notFound, param, parse } from "../lib/http.js";
import { fetchPosts } from "../lib/posts.js";
import { USER_COLUMNS, type UserRow, profileUser, publicUser, selfUser } from "../lib/users.js";
import { deleteObject, ownsKey } from "../storage.js";
import { usernameSchema } from "./auth.js";

export const router = Router();

async function findUser(username: string) {
  const user = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [username.toLowerCase()]);
  if (!user) throw notFound("We couldn't find that person");
  return user;
}

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
       WHERE u.id <> $1
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

router.get("/users/:username", async (req, res) => {
  const user = await findUser(param(req, "username"));
  const me = req.userId;
  const [stats] = await db.query<{
    posts: number;
    followers: number;
    following: number;
    is_following: boolean;
    follows_me: boolean;
  }>(
    `SELECT
       (SELECT count(*)::int FROM posts WHERE author_id = $1 AND (NOT is_anonymous OR author_id = $2::uuid)) AS posts,
       (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers,
       (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $2::uuid AND followee_id = $1) AS is_following,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2::uuid) AS follows_me`,
    [user.id, me ?? null],
  );
  const isMe = me === user.id;
  res.json({
    user: profileUser(user),
    isMe,
    isFollowing: stats!.is_following,
    followsMe: stats!.follows_me,
    // Follower counts stay private: only you can see your own.
    stats: { posts: stats!.posts, followers: isMe ? stats!.followers : null, following: isMe ? stats!.following : null },
  });
});

router.get("/users/:username/posts", async (req, res) => {
  const user = await findUser(param(req, "username"));
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
