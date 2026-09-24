import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, signToken, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { HttpError, parse } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { USER_COLUMNS, type UserRow, selfUser } from "../lib/users.js";

export const router = Router();

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,24}$/, "Use 3–24 letters, numbers or underscores");

const registerSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(50),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});

const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1, "Enter your email or username"),
  password: z.string().min(1, "Enter your password"),
});

const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20 });

router.post("/register", authLimiter, async (req, res) => {
  const input = parse(registerSchema, req.body);
  const taken = await one<{ email: string; username: string }>(
    "SELECT lower(email) AS email, username FROM users WHERE lower(email) = $1 OR username = $2 LIMIT 1",
    [input.email, input.username],
  );
  if (taken) {
    throw new HttpError(409, taken.username === input.username ? "That username is taken" : "An account with that email already exists");
  }
  const passwordHash = await bcrypt.hash(input.password, 10);
  const [user] = await db.query<UserRow>(
    `INSERT INTO users (email, username, display_name, password_hash)
     VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
    [input.email, input.username, input.displayName, passwordHash],
  );
  res.status(201).json({ token: signToken(user!.id), user: selfUser(user!) });
});

router.post("/login", authLimiter, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await one<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = $1 OR username = $1 LIMIT 1`,
    [input.identifier],
  );
  const ok = user && (await bcrypt.compare(input.password, user.password_hash));
  if (!user || !ok) throw new HttpError(401, "That email/username and password don't match");
  res.json({ token: signToken(user.id), user: selfUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [viewer(req)]);
  if (!user) throw new HttpError(401, "Your session has ended. Please sign in again");
  res.json({ user: selfUser(user) });
});
