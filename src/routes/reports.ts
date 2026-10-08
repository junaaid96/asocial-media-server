import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import { visiblePost } from "../lib/posts.js";

export const router = Router();

export const REPORT_REASONS = ["spam", "harassment", "hate", "self_harm", "sexual", "violence", "misinformation", "impersonation", "other"] as const;

const reportSchema = z
  .object({
    targetType: z.enum(["user", "post", "message"]),
    username: z.string().trim().toLowerCase().optional(),
    postId: z.uuid().optional(),
    messageId: z.uuid().optional(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(1000).default(""),
  })
  .refine((r) => r.reason !== "other" || r.details.length >= 3, { message: "Tell us a little about what's wrong", path: ["details"] });

router.post("/reports", requireAuth, async (req, res) => {
  const me = viewer(req);
  const input = parse(reportSchema, req.body);
  let targetUserId: string | undefined;
  let postId: string | null = null;
  let messageId: string | null = null;
  let excerpt = "";

  if (input.targetType === "user") {
    const user = await one<{ id: string; bio: string; display_name: string }>("SELECT id, bio, display_name FROM users WHERE username = $1", [
      (input.username ?? "").replace(/^@/, ""),
    ]);
    if (!user) throw notFound("We couldn't find that person");
    targetUserId = user.id;
    excerpt = `${user.display_name}${user.bio ? ` — ${user.bio}` : ""}`;
  } else if (input.targetType === "post") {
    if (!input.postId) throw new HttpError(400, "postId is required");
    const post = await visiblePost(input.postId, me);
    if (!post) throw notFound("This post has drifted away");
    targetUserId = post.author_id;
    postId = input.postId;
    excerpt = post.body;
  } else {
    if (!input.messageId) throw new HttpError(400, "messageId is required");
    // You can only report messages sent to you, in your own conversations.
    const message = await one<{ sender_id: string; body: string }>(
      `SELECT m.sender_id, m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND (c.user_a = $2 OR c.user_b = $2)`,
      [input.messageId, me],
    );
    if (!message) throw notFound("That message doesn't exist");
    targetUserId = message.sender_id;
    messageId = input.messageId;
    excerpt = message.body;
  }
  if (targetUserId === me) throw new HttpError(400, "You can't report yourself");

  const [row] = await db.query<{ id: string }>(
    `INSERT INTO reports (reporter_id, target_type, target_user_id, post_id, message_id, excerpt, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (reporter_id, target_type, coalesce(post_id, message_id, target_user_id)) WHERE status = 'open' DO NOTHING
     RETURNING id`,
    [me, input.targetType, targetUserId, postId, messageId, excerpt.slice(0, 2000), input.reason, input.details],
  );
  if (!row) throw new HttpError(409, "You've already reported this. Our moderators will take a look soon.");
  res.status(201).json({ id: row.id });
});
