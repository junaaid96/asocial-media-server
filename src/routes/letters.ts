import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { HttpError, idParam, notFound, parse } from "../lib/http.js";
import { publicUser } from "../lib/users.js";

export const router = Router();
router.use("/letters", requireAuth);

// Letters travel slowly on purpose, like a pen pal's post.
export const PACES = {
  breeze: 15,
  afternoon: 3 * 60,
  overnight: 12 * 60,
} as const;

interface LetterRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  reply_to: string | null;
  body: string;
  created_at: Date;
  deliver_at: Date;
  read_at: Date | null;
  s_username: string;
  s_display_name: string;
  s_avatar_key: string | null;
  s_battery: string;
  r_username: string;
  r_display_name: string;
  r_avatar_key: string | null;
  r_battery: string;
  reply_excerpt: string | null;
}

const LETTER_SELECT = `
  SELECT l.*, s.username AS s_username, s.display_name AS s_display_name, s.avatar_key AS s_avatar_key, s.battery AS s_battery,
         r.username AS r_username, r.display_name AS r_display_name, r.avatar_key AS r_avatar_key, r.battery AS r_battery,
         left(parent.body, 140) AS reply_excerpt
  FROM letters l
  JOIN users s ON s.id = l.sender_id
  JOIN users r ON r.id = l.recipient_id
  LEFT JOIN letters parent ON parent.id = l.reply_to`;

function serializeLetter(row: LetterRow, me: string, full: boolean) {
  const arrived = new Date(row.deliver_at).getTime() <= Date.now();
  return {
    id: row.id,
    direction: row.sender_id === me ? "sent" : "received",
    from: publicUser({ username: row.s_username, display_name: row.s_display_name, avatar_key: row.s_avatar_key, battery: row.s_battery }),
    to: publicUser({ username: row.r_username, display_name: row.r_display_name, avatar_key: row.r_avatar_key, battery: row.r_battery }),
    body: full ? row.body : row.body.slice(0, 160),
    replyTo: row.reply_to ? { id: row.reply_to, excerpt: row.reply_excerpt } : null,
    sentAt: row.created_at,
    deliverAt: row.deliver_at,
    arrived,
    readAt: row.read_at,
  };
}

router.get("/letters", async (req, res) => {
  const me = viewer(req);
  const box = req.query.box === "sent" ? "sent" : "inbox";
  const rows = await db.query<LetterRow>(
    box === "inbox"
      ? `${LETTER_SELECT} WHERE l.recipient_id = $1 AND l.deliver_at <= now() ORDER BY l.deliver_at DESC LIMIT 100`
      : `${LETTER_SELECT} WHERE l.sender_id = $1 ORDER BY l.created_at DESC LIMIT 100`,
    [me],
  );
  const [transit] = await db.query<{ incoming: number }>(
    "SELECT count(*)::int AS incoming FROM letters WHERE recipient_id = $1 AND deliver_at > now()",
    [me],
  );
  res.json({ items: rows.map((row) => serializeLetter(row, me, false)), incoming: transit?.incoming ?? 0 });
});

router.get("/letters/:id", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const row = await one<LetterRow>(`${LETTER_SELECT} WHERE l.id = $1`, [id]);
  const isRecipient = row?.recipient_id === me;
  if (!row || (row.sender_id !== me && !isRecipient)) throw notFound("That letter isn't addressed to you");
  // A letter still in transit can't be opened by its recipient.
  if (isRecipient && new Date(row.deliver_at).getTime() > Date.now()) throw notFound("That letter is still on its way");
  if (isRecipient && !row.read_at) {
    await db.query("UPDATE letters SET read_at = now() WHERE id = $1", [id]);
    await db.query("UPDATE notifications SET read_at = now() WHERE letter_id = $1 AND read_at IS NULL", [id]);
    row.read_at = new Date();
  }
  res.json({ letter: serializeLetter(row, me, true) });
});

const sendSchema = z.object({
  to: z.string().trim().toLowerCase().min(1, "Choose who to write to"),
  body: z.string().trim().min(1, "Your letter is empty").max(5000),
  pace: z.enum(Object.keys(PACES) as [keyof typeof PACES, ...(keyof typeof PACES)[]]).default("afternoon"),
  replyTo: z.uuid().optional(),
});

router.post("/letters", async (req, res) => {
  const me = viewer(req);
  const input = parse(sendSchema, req.body);
  const recipient = await one<{ id: string; letters_from: string; follows_me: boolean }>(
    `SELECT u.id, u.letters_from,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.followee_id = $2) AS follows_me
     FROM users u WHERE u.username = $1`,
    [input.to.replace(/^@/, ""), me],
  );
  if (!recipient) throw notFound("We couldn't find that person");
  if (recipient.id === me) throw new HttpError(400, "Letters to yourself belong in a journal");
  if (recipient.letters_from === "nobody") throw new HttpError(403, "They aren't receiving letters right now");
  if (recipient.letters_from === "following" && !recipient.follows_me) {
    throw new HttpError(403, "They only receive letters from people they follow");
  }
  if (input.replyTo) {
    const parent = await one("SELECT 1 FROM letters WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2)", [input.replyTo, me]);
    if (!parent) throw new HttpError(400, "You can only reply to your own letters");
  }
  const [row] = await db.query<{ id: string; deliver_at: Date }>(
    `INSERT INTO letters (sender_id, recipient_id, body, reply_to, deliver_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id, deliver_at`,
    [me, recipient.id, input.body, input.replyTo ?? null, PACES[input.pace]],
  );
  // The notification only becomes visible once the letter arrives.
  await db.query(
    "INSERT INTO notifications (user_id, actor_id, type, letter_id, created_at) VALUES ($1, $2, 'letter', $3, $4)",
    [recipient.id, me, row!.id, row!.deliver_at],
  );
  res.status(201).json({ id: row!.id, deliverAt: row!.deliver_at });
});
