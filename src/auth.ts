import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env.js";
import { HttpError } from "./lib/http.js";

const TOKEN_TTL = "30d";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function signToken(userId: string): string {
  return jwt.sign({}, env.jwtSecret, { subject: userId, expiresIn: TOKEN_TTL, algorithm: "HS256" });
}

function readToken(req: Request): string | undefined {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

/** Attaches req.userId when a valid token is present; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
      if (typeof payload === "object" && typeof payload.sub === "string") req.userId = payload.sub;
    } catch {
      // An expired or malformed token just means "signed out".
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.userId) return next(new HttpError(401, "Please sign in first"));
  next();
}

export function viewer(req: Request): string {
  if (!req.userId) throw new HttpError(401, "Please sign in first");
  return req.userId;
}
