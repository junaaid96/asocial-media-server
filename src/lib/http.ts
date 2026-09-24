import type { Request } from "express";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (message = "You can't do that") => new HttpError(403, message);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw new HttpError(400, first ? `${field ? `${field}: ` : ""}${first.message}` : "Invalid request", z.flattenError(result.error));
  }
  return result.data;
}

export const uuid = z.uuid();

export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value.join("/") : String(value ?? "");
}

export function idParam(req: Request, name = "id"): string {
  const value = param(req, name);
  if (!uuid.safeParse(value).success) throw notFound();
  return value;
}
