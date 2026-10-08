import { Router } from "express";
import { requireAuth, viewer } from "../auth.js";
import { db } from "../db.js";
import { plainExcerpt } from "../lib/richtext.js";
import { publicUser } from "../lib/users.js";

export const router = Router();
router.use("/notifications", requireAuth);

interface NotificationRow {
  id: string;
  type: string;
  post_id: string | null;
  letter_id: string | null;
  comment_id: string | null;
  created_at: Date;
  read_at: Date | null;
  username: string | null;
  display_name: string | null;
  avatar_key: string | null;
  battery: string | null;
  post_excerpt: string | null;
  comment_excerpt: string | null;
  reaction: string | null;
}

router.get("/notifications", async (req, res) => {
  const me = viewer(req);
  const rows = await db.query<NotificationRow>(
    `SELECT n.id, n.type, n.post_id, n.letter_id, n.comment_id, n.created_at, n.read_at,
            u.username, u.display_name, u.avatar_key, u.battery,
            p.body AS post_excerpt,
            c.body AS comment_excerpt,
            CASE WHEN n.type = 'comment_reaction'
              THEN (SELECT cr.kind FROM comment_reactions cr WHERE cr.comment_id = n.comment_id AND cr.user_id = n.actor_id)
              ELSE (SELECT r.kind FROM reactions r WHERE r.post_id = n.post_id AND r.user_id = n.actor_id)
            END AS reaction
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id AND u.suspended_at IS NULL
     LEFT JOIN posts p ON p.id = n.post_id
     LEFT JOIN comments c ON c.id = n.comment_id
     WHERE n.user_id = $1 AND n.created_at <= now()
       -- Hide activity from suspended accounts.
       AND (n.actor_id IS NULL OR u.id IS NOT NULL)
     ORDER BY n.created_at DESC
     LIMIT 60`,
    [me],
  );
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      read: !!row.read_at,
      actor: row.username
        ? publicUser({ username: row.username, display_name: row.display_name!, avatar_key: row.avatar_key, battery: row.battery! })
        : null,
      postId: row.post_id,
      postExcerpt: row.post_excerpt ? plainExcerpt(row.post_excerpt, 100) : null,
      commentId: row.comment_id,
      commentExcerpt: row.comment_excerpt ? plainExcerpt(row.comment_excerpt, 100) : null,
      letterId: row.letter_id,
      reaction: row.reaction,
    })),
  });
});

router.get("/notifications/summary", async (req, res) => {
  const [row] = await db.query<{ unread: number; letters: number; messages: number }>(
    `SELECT
       (SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL AND created_at <= now()) AS unread,
       (SELECT count(*)::int FROM letters WHERE recipient_id = $1 AND read_at IS NULL AND deliver_at <= now()) AS letters,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE (c.user_a = $1 OR c.user_b = $1) AND m.sender_id <> $1 AND m.read_at IS NULL) AS messages`,
    [viewer(req)],
  );
  res.json(row);
});

router.post("/notifications/read", async (req, res) => {
  await db.query(
    "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND created_at <= now() AND type <> 'letter'",
    [viewer(req)],
  );
  res.status(204).end();
});
