import { Router } from "express";
import { db } from "../db.js";
import { fetchPosts } from "../lib/posts.js";
import { type UserRow, publicUser } from "../lib/users.js";

export const router = Router();

router.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  if (q.length < 2) return res.json({ people: [], posts: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [people, posts] = await Promise.all([
    db.query<UserRow>(
      `SELECT username, display_name, avatar_key, battery, bio FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY (username ILIKE $2) DESC, created_at DESC LIMIT 6`,
      [like, `${q.replace(/^@/, "")}%`],
    ),
    fetchPosts({
      viewerId: req.userId,
      limit: 20,
      where: (p) => [`p.search @@ websearch_to_tsquery('english', ${p.add(q)})`],
    }),
  ]);
  res.json({
    people: people.map((row) => ({ ...publicUser(row), bio: row.bio })),
    posts: posts.items,
  });
});

