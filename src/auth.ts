import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { one } from "./db.js";
import { env } from "./env.js";
import { HttpError } from "./lib/http.js";

const TOKEN_TTL = "30d";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      role?: "user" | "admin";
      suspended?: boolean;
    }
  }
}

export function signToken(userId: string): string {
  return jwt.sign({}, env.jwtSecret, { subject: userId, expiresIn: TOKEN_TTL, algorithm: "HS256" });
}

/** Returns the user id inside a valid token, or undefined. */
export function verifyToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    return typeof payload === "object" && typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    // An expired or malformed token just means "signed out".
    return undefined;
  }
}

function readToken(req: Request): string | undefined {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

export interface AccountState {
  role: "user" | "admin";
  suspended: boolean;
}

// Role and suspension are looked up per request (so moderation takes effect quickly),
// with a short per-instance cache to keep that to one query every few seconds per user.
const STATE_TTL_MS = 10_000;
const stateCache = new Map<string, { state: AccountState | null; expires: number }>();

export async function accountState(userId: string): Promise<AccountState | null> {
  const cached = stateCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.state;
  const row = await one<{ role: "user" | "admin"; suspended: boolean }>(
    "SELECT role, suspended_at IS NOT NULL AS suspended FROM users WHERE id = $1",
    [userId],
  );
  const state = row ? { role: row.role, suspended: row.suspended } : null;
  stateCache.set(userId, { state, expires: Date.now() + STATE_TTL_MS });
  if (stateCache.size > 10_000) stateCache.clear();
  return state;
}

export function forgetAccountState(userId: string) {
  stateCache.delete(userId);
}

/** Attaches req.userId (plus role/suspension) when a valid token is present; never rejects. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const userId = verifyToken(readToken(req));
  if (!userId) return next();
  try {
    const state = await accountState(userId);
    if (state) {
      req.userId = userId;
      req.role = state.role;
      req.suspended = state.suspended;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export const SUSPENDED_MESSAGE = "This account is suspended. If you think this is a mistake, please contact the aSocial team.";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.userId) return next(new HttpError(401, "Please sign in first"));
  if (req.suspended) return next(new HttpError(403, SUSPENDED_MESSAGE));
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, (error?: unknown) => {
    if (error) return next(error);
    if (req.role !== "admin") return next(new HttpError(403, "Moderators only"));
    next();
  });
}

export function viewer(req: Request): string {
  if (!req.userId) throw new HttpError(401, "Please sign in first");
  return req.userId;
}
