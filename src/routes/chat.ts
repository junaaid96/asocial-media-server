import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { HttpError, idParam, notFound, parse } from "../lib/http.js";
import { sanitizeRichText } from "../lib/richtext.js";
import { publicUser } from "../lib/users.js";
import { isOnline, publish } from "../realtime.js";

export const router = Router();
router.use(["/conversations", "/messages"], requireAuth);

interface ConversationRow {
  id: string;
  user_a: string;
  user_b: string;
  created_at: Date;
  last_message_at: Date | null;
  other_id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  battery: string;
  letters_from: string;
  last_seen_at: Date | null;
  suspended: boolean;
  last_body: string | null;
  last_sender: string | null;
  last_created_at: Date | null;
  unread: number;
  they_follow_me: boolean;
  they_wrote: boolean;
}

const CONVERSATION_SELECT = `
  SELECT c.id, c.user_a, c.user_b, c.created_at, c.last_message_at,
         o.id AS other_id, o.username, o.display_name, o.avatar_key, o.battery, o.letters_from, o.last_seen_at,
         o.suspended_at IS NOT NULL AS suspended,
         lm.body AS last_body, lm.sender_id AS last_sender, lm.created_at AS last_created_at,
         (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread,
         EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = o.id AND f.followee_id = $1) AS they_follow_me,
         EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id = o.id) AS they_wrote
  FROM conversations c
  JOIN users o ON o.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
  LEFT JOIN LATERAL (
    SELECT body, sender_id, created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
  ) lm ON true`;

/** Who may message whom: the recipient's "who can write to you" setting, unless they've already written back. */
function canMessage(row: Pick<ConversationRow, "letters_from" | "they_follow_me" | "they_wrote" | "suspended">) {
  if (row.suspended) return false;
  if (row.they_wrote) return true;
  if (row.letters_from === "nobody") return false;
  if (row.letters_from === "following") return row.they_follow_me;
  return true;
}

function serializeConversation(row: ConversationRow, me: string) {
  const online = isOnline(row.other_id);
  return {
    id: row.id,
    other: {
      ...publicUser(row),
      online,
      lastSeenAt: online ? null : row.last_seen_at,
    },
    lastMessage: row.last_created_at
      ? { body: (row.last_body ?? "").slice(0, 160), createdAt: row.last_created_at, fromMe: row.last_sender === me }
      : null,
    unread: row.unread,
    canMessage: canMessage(row),
    updatedAt: row.last_message_at ?? row.created_at,
  };
}

async function conversationFor(id: string, me: string) {
  const row = await one<ConversationRow>(`${CONVERSATION_SELECT} WHERE c.id = $2 AND (c.user_a = $1 OR c.user_b = $1)`, [me, id]);
  if (!row) throw notFound("That conversation doesn't exist");
  return row;
}

router.get("/conversations", async (req, res) => {
  const me = viewer(req);
  const rows = await db.query<ConversationRow>(
    `${CONVERSATION_SELECT} WHERE (c.user_a = $1 OR c.user_b = $1)
     ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 100`,
    [me],
  );
  // Empty conversations (opened, nothing sent yet) stay out of the list; the client opens them directly.
  res.json({ items: rows.filter((row) => row.last_created_at).map((row) => serializeConversation(row, me)) });
});

router.post("/conversations", async (req, res) => {
  const me = viewer(req);
  const { username } = parse(z.object({ username: z.string().trim().toLowerCase().min(1, "Choose who to message") }), req.body);
  const other = await one<{ id: string }>("SELECT id FROM users WHERE username = $1 AND suspended_at IS NULL", [username.replace(/^@/, "")]);
  if (!other) throw notFound("We couldn't find that person");
  if (other.id === me) throw new HttpError(400, "Messages to yourself belong in a journal");
  const [a, b] = me < other.id ? [me, other.id] : [other.id, me];
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2)
     ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = EXCLUDED.user_a RETURNING id`,
    [a, b],
  );
  const conversation = await conversationFor(row!.id, me);
  if (!canMessage(conversation) && !conversation.last_created_at) {
    throw new HttpError(403, conversation.letters_from === "nobody" ? "They aren't receiving messages right now" : "They only receive messages from people they follow");
  }
  res.status(201).json({ conversation: serializeConversation(conversation, me) });
});

router.get("/conversations/:id", async (req, res) => {
  const me = viewer(req);
  res.json({ conversation: serializeConversation(await conversationFor(idParam(req), me), me) });
});

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  client_id: string | null;
  created_at: Date;
  read_at: Date | null;
  sender_username: string;
}

function serializeMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender_username,
    body: row.body,
    clientId: row.client_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

const MESSAGE_SELECT = `SELECT m.*, u.username AS sender_username FROM messages m JOIN users u ON u.id = m.sender_id`;

const historyQuery = z.object({
  // Older page: messages before this message id. Catch-up after reconnecting: messages after this message id.
  before: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

router.get("/conversations/:id/messages", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { before, after, limit } = parse(historyQuery, req.query);
  await conversationFor(id, me);
  let rows: MessageRow[];
  if (after) {
    rows = await db.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.conversation_id = $1
         AND (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1)
       ORDER BY m.created_at ASC, m.id ASC LIMIT $3`,
      [id, after, limit + 1],
    );
    const hasMore = rows.length > limit;
    return res.json({ items: rows.slice(0, limit).map(serializeMessage), hasMore });
  }
  rows = await db.query<MessageRow>(
    `${MESSAGE_SELECT} WHERE m.conversation_id = $1
       ${before ? "AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $3 AND conversation_id = $1)" : ""}
     ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
    before ? [id, limit + 1, before] : [id, limit + 1],
  );
  const hasMore = rows.length > limit;
  // Oldest first, ready to render top-to-bottom.
  res.json({ items: rows.slice(0, limit).reverse().map(serializeMessage), hasMore });
});

const sendSchema = z.object({
  body: z.string().max(4000).transform(sanitizeRichText).pipe(z.string().min(1, "Write a message first").max(2000)),
  clientId: z.string().trim().min(1).max(64).optional(),
});

// Per-user send budget: generous for conversation, tight enough to stop floods.
const sendBudget = new Map<string, { count: number; resetAt: number }>();
function spendSendBudget(userId: string) {
  const now = Date.now();
  const entry = sendBudget.get(userId);
  if (!entry || entry.resetAt < now) {
    sendBudget.set(userId, { count: 1, resetAt: now + 60_000 });
    if (sendBudget.size > 5000) for (const [k, v] of sendBudget) if (v.resetAt < now) sendBudget.delete(k);
    return;
  }
  if (++entry.count > 60) throw new HttpError(429, "That's a lot of messages at once. Take a breath and try again in a minute");
}

router.post("/conversations/:id/messages", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const input = parse(sendSchema, req.body);
  const conversation = await conversationFor(id, me);
  if (!canMessage(conversation)) throw new HttpError(403, "They aren't receiving messages from you right now");
  spendSendBudget(me);
  // client_id makes retries after a dropped connection idempotent.
  const [inserted] = await db.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, sender_id, body, client_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
    [id, me, input.body, input.clientId ?? null],
  );
  let row: MessageRow | undefined;
  if (inserted) {
    await db.query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [id]);
    row = await one<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [inserted.id]);
    publish([conversation.user_a, conversation.user_b], { type: "message", conversationId: id, message: serializeMessage(row!) });
    res.status(201);
  } else {
    row = await one<MessageRow>(`${MESSAGE_SELECT} WHERE m.sender_id = $1 AND m.client_id = $2`, [me, input.clientId]);
  }
  res.json({ message: serializeMessage(row!) });
});

router.post("/conversations/:id/read", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const conversation = await conversationFor(id, me);
  const rows = await db.query<{ read_at: Date }>(
    "UPDATE messages SET read_at = now() WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL RETURNING read_at",
    [id, me],
  );
  if (rows.length) {
    const [meRow] = await db.query<{ username: string }>("SELECT username FROM users WHERE id = $1", [me]);
    publish([conversation.other_id], {
      type: "read",
      conversationId: id,
      readerUsername: meRow!.username,
      readAt: new Date(rows[0]!.read_at).toISOString(),
    });
  }
  res.json({ read: rows.length });
});

router.get("/messages/unread", async (req, res) => {
  const [row] = await db.query<{ unread: number }>(
    `SELECT count(*)::int AS unread FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE (c.user_a = $1 OR c.user_b = $1) AND m.sender_id <> $1 AND m.read_at IS NULL`,
    [viewer(req)],
  );
  res.json({ unread: row?.unread ?? 0 });
});
