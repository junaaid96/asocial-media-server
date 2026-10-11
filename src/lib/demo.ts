import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { HttpError } from "./http.js";

// Public demo accounts behind the "Explore the demo" buttons on the login page.
// The password is public on purpose, so these accounts are read-mostly: they can
// browse, react, bookmark and follow, but can't publish anything, message people,
// moderate, or change their own credentials.
export const DEMO_PASSWORD = "aSocialDemo!2026";
export const DEMO_ACCOUNTS = [
  { username: "demo_member", email: "demo_member@demo.asocial", displayName: "Demo Member", role: "user" },
  { username: "demo_admin", email: "demo_admin@demo.asocial", displayName: "Demo Admin", role: "admin" },
] as const;
const DEMO_USERNAMES = DEMO_ACCOUNTS.map((a) => a.username);

export const DEMO_BLOCKED_MESSAGE = "This is a shared demo account, so it can look around but not post, message, moderate or change settings. Create a free account to join in.";

// Writes a demo account may still make (they only affect the demo account itself).
const ALLOWED: Array<[string, RegExp]> = [
  ["POST", /^\/api\/auth\/(login|register)$/],
  ["PUT", /^\/api\/(posts|comments)\/[^/]+\/reaction$/],
  ["DELETE", /^\/api\/(posts|comments)\/[^/]+\/reaction$/],
  ["POST", /^\/api\/posts\/[^/]+\/bookmark$/],
  ["DELETE", /^\/api\/posts\/[^/]+\/bookmark$/],
  ["POST", /^\/api\/users\/[^/]+\/follow$/],
  ["DELETE", /^\/api\/users\/[^/]+\/follow$/],
  ["POST", /^\/api\/notifications\/read$/],
  ["POST", /^\/api\/conversations\/[^/]+\/read$/],
  ["POST", /^\/api\/realtime\/token$/],
  ["POST", /^\/api\/me\/usage$/],
];

const TTL_MS = 60_000;
let cache: { ids: Set<string>; expires: number } | null = null;

export async function demoUserIds(): Promise<Set<string>> {
  if (cache && cache.expires > Date.now()) return cache.ids;
  const rows = await db.query<{ id: string }>("SELECT id FROM users WHERE username = ANY($1)", [DEMO_USERNAMES]);
  cache = { ids: new Set(rows.map((r) => r.id)), expires: Date.now() + TTL_MS };
  return cache.ids;
}

export function isDemoWriteAllowed(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

/** Runs after optionalAuth: blocks content-creating / moderating writes from demo accounts. */
export async function demoGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.userId || isDemoWriteAllowed(req.method, req.path)) return next();
    if ((await demoUserIds()).has(req.userId)) throw new HttpError(403, DEMO_BLOCKED_MESSAGE);
    next();
  } catch (error) {
    next(error);
  }
}
