import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./http.js";

/**
 * A small in-memory limiter. Serverless instances don't share memory, so this
 * is a speed bump against brute force rather than a hard guarantee.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
      }
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return next(new HttpError(429, "Too many attempts. Take a breath and try again in a few minutes"));
    next();
  };
}
