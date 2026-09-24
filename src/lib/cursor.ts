import { HttpError } from "./http.js";

export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(createdAt: Date | string, id: string): string {
  const t = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(JSON.stringify({ t, id })).toString("base64url");
}

export function decodeCursor(raw: unknown): Cursor | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof value.t !== "string" || typeof value.id !== "string" || Number.isNaN(Date.parse(value.t))) {
      throw new Error("bad cursor");
    }
    return value;
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

export function pageLimit(raw: unknown, fallback = 10, max = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}
