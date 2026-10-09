import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db } from "../db.js";
import { ablyEnabled, inboxChannel, presenceChannel, tokenRequestFor } from "../ably.js";
import { HttpError, idParam, notFound, parse } from "../lib/http.js";
import { otherParticipant, publish } from "../realtime.js";

export const router = Router();
router.use(["/realtime", "/conversations/:id/typing"], requireAuth);

/**
 * Ably token request for the signed-in user (used by ably-js as its authCallback).
 * The token can only subscribe to the user's own inbox, enter their own presence, and watch
 * the presence of people they have a conversation with. The API key never leaves the server.
 */
router.post("/realtime/token", async (req, res) => {
  if (!ablyEnabled()) throw new HttpError(503, "Live updates over Ably aren't configured here");
  const me = viewer(req);
  const partners = await db.query<{ id: string; username: string }>(
    `SELECT u.id, u.username FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
     WHERE c.user_a = $1 OR c.user_b = $1
     ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 200`,
    [me],
  );
  const tokenRequest = await tokenRequestFor(
    me,
    partners.map((p) => p.id),
  );
  res.set("Cache-Control", "no-store");
  res.json({
    tokenRequest,
    channels: {
      inbox: inboxChannel(me),
      presence: presenceChannel(me),
      partners: partners.map((p) => ({ userId: p.id, username: p.username, presence: presenceChannel(p.id) })),
    },
  });
});

// Typing indicators, for clients on Ably (subscribe-only tokens can't publish).
const typingBudget = new Map<string, { count: number; resetAt: number }>();
function spendTypingBudget(userId: string) {
  const now = Date.now();
  const entry = typingBudget.get(userId);
  if (!entry || entry.resetAt < now) {
    typingBudget.set(userId, { count: 1, resetAt: now + 10_000 });
    if (typingBudget.size > 5000) for (const [k, v] of typingBudget) if (v.resetAt < now) typingBudget.delete(k);
    return true;
  }
  return ++entry.count <= 20;
}

router.post("/conversations/:id/typing", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { typing } = parse(z.object({ typing: z.boolean() }), req.body ?? {});
  const other = await otherParticipant(id, me);
  if (!other) throw notFound("That conversation doesn't exist");
  if (spendTypingBudget(me)) {
    const [row] = await db.query<{ username: string }>("SELECT username FROM users WHERE id = $1", [me]);
    await publish([other], { type: "typing", conversationId: id, username: row!.username, typing });
  }
  res.status(204).end();
});
