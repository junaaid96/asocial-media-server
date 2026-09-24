import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { requireAuth, viewer } from "../auth.js";
import { HttpError, param } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { IMAGE_TYPES, KEY_PATTERN, MAX_UPLOAD_BYTES, fileUrl, putObject, signedDownloadUrl, sniffImageType } from "../storage.js";

export const router = Router();

// Images are compressed in the browser, then streamed here and stored in the
// private Neon Object Storage bucket under the uploader's own prefix.
router.post(
  "/uploads",
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 20 }),
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const me = viewer(req);
    const kind = req.query.kind === "avatar" ? "avatars" : "posts";
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "Choose an image to upload");
    const type = sniffImageType(body);
    if (!type) throw new HttpError(415, "Only JPEG, PNG, WebP and GIF images are supported");
    const key = `${kind}/${me}/${randomUUID()}.${IMAGE_TYPES[type]}`;
    await putObject(key, body, type);
    res.status(201).json({ key, url: fileUrl(key) });
  },
);

// Files live in a private bucket. Redirect to a presigned URL and let the CDN
// cache the redirect so repeat views never touch the function.
router.get("/files/*key", async (req, res) => {
  const key = param(req, "key");
  if (!KEY_PATTERN.test(key)) throw new HttpError(404, "File not found");
  const url = await signedDownloadUrl(key);
  res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  res.redirect(302, url);
});
