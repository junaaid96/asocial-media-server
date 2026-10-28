import { Router } from "express";
import { z } from "zod";
import { requireAuth, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { HttpError, idParam, parse } from "../lib/http.js";
import { PARTNERED_LABELS, isVerified, publicUser, type UserRow } from "../lib/users.js";

export const router = Router();

// --- Verification ----------------------------------------------------------
// People request verification; only moderators can grant it.

const verificationNote = z.object({ note: z.string().trim().max(500).default("") });

async function myVerificationState(me: string) {
  const user = await one<Pick<UserRow, "verified_at" | "verified_label" | "role">>(
    "SELECT verified_at, verified_label, role FROM users WHERE id = $1",
    [me],
  );
  const [open] = await db.query<{ id: string; note: string; created_at: Date }>(
    "SELECT id, note, created_at FROM verification_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1",
    [me],
  );
  const [last] = await db.query<{ status: string; resolved_at: Date | null }>(
    "SELECT status, resolved_at FROM verification_requests WHERE user_id = $1 AND status <> 'pending' ORDER BY resolved_at DESC LIMIT 1",
    [me],
  );
  return {
    verified: user ? isVerified(user) : false,
    verifiedLabel: user && isVerified(user) ? user.verified_label : null,
    pending: open ? { id: open.id, note: open.note, createdAt: open.created_at } : null,
    lastDecision: last ? { status: last.status, resolvedAt: last.resolved_at } : null,
  };
}

router.get("/me/verification", requireAuth, async (req, res) => {
  res.json(await myVerificationState(viewer(req)));
});

router.post("/me/verification", requireAuth, async (req, res) => {
  const me = viewer(req);
  const { note } = parse(verificationNote, req.body ?? {});
  const user = await one<Pick<UserRow, "verified_at" | "role">>("SELECT verified_at, role FROM users WHERE id = $1", [me]);
  if (user && isVerified(user)) throw new HttpError(400, "You're already verified");
  const rows = await db.query(
    `INSERT INTO verification_requests (user_id, note) VALUES ($1, $2)
     ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
    [me, note],
  );
  if (!rows.length) throw new HttpError(409, "You already have a request waiting for review");
  res.status(201).json(await myVerificationState(me));
});

router.delete("/me/verification", requireAuth, async (req, res) => {
  const rows = await db.query("DELETE FROM verification_requests WHERE user_id = $1 AND status = 'pending' RETURNING id", [
    viewer(req),
  ]);
  if (!rows.length) throw new HttpError(404, "You don't have a pending request");
  res.json(await myVerificationState(viewer(req)));
});

// --- Relationship status ---------------------------------------------------
// Solo ("single") shows immediately. Partnered labels only appear on both
// profiles after the partner confirms.

const partneredSchema = z.enum(PARTNERED_LABELS);

interface RelationshipRow {
  id: string;
  requester_id: string;
  partner_id: string;
  label: string;
  status: string;
  created_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
  battery: string;
  verified_at: Date | null;
  verified_label: string | null;
  role: "user" | "admin";
}

const RELATIONSHIP_SELECT = `
  SELECT r.id, r.requester_id, r.partner_id, r.label, r.status, r.created_at,
         u.username, u.display_name, u.avatar_key, u.battery, u.verified_at, u.verified_label, u.role
  FROM relationships r
  JOIN users u ON u.id = CASE WHEN r.requester_id = $1 THEN r.partner_id ELSE r.requester_id END`;

function serializeRelationship(row: RelationshipRow, me: string) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    outgoing: row.requester_id === me,
    other: publicUser(row),
  };
}

/** Any pending or confirmed involvement for this person (at most one is allowed). */
async function involvement(userId: string) {
  return one<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE (r.requester_id = $1 OR r.partner_id = $1) AND u.suspended_at IS NULL LIMIT 1`,
    [userId],
  );
}

router.get("/me/relationship", requireAuth, async (req, res) => {
  const me = viewer(req);
  const [solo] = await db.query<{ relationship_label: string | null }>("SELECT relationship_label FROM users WHERE id = $1", [me]);
  const [outgoing] = await db.query<RelationshipRow>(`${RELATIONSHIP_SELECT} WHERE r.requester_id = $1 AND r.status = 'pending' LIMIT 1`, [me]);
  const incoming = await db.query<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE r.partner_id = $1 AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 20`,
    [me],
  );
  const [confirmed] = await db.query<RelationshipRow>(
    `${RELATIONSHIP_SELECT} WHERE (r.requester_id = $1 OR r.partner_id = $1) AND r.status = 'confirmed' LIMIT 1`,
    [me],
  );
  res.json({
    solo: solo?.relationship_label ?? null,
    confirmed: confirmed ? serializeRelationship(confirmed, me) : null,
    outgoing: outgoing ? serializeRelationship(outgoing, me) : null,
    incoming: incoming.map((row) => serializeRelationship(row, me)),
  });
});

router.put("/me/relationship/solo", requireAuth, async (req, res) => {
  const me = viewer(req);
  const { label } = parse(z.object({ label: z.enum(["single"]).nullable() }), req.body ?? {});
  if (label && (await involvement(me))) {
    throw new HttpError(409, "End your current relationship status first, then set this");
  }
  await db.query("UPDATE users SET relationship_label = $2 WHERE id = $1", [me, label]);
  res.json({ solo: label });
});

router.post("/me/relationship", requireAuth, async (req, res) => {
  const me = viewer(req);
  const { label, partnerUsername: rawPartner } = parse(
    z.object({
      label: partneredSchema,
      partnerUsername: z.string().trim().min(3).max(25),
    }),
    req.body ?? {},
  );
  const partnerUsername = rawPartner.toLowerCase().replace(/^@/, "");
  const partner = await one<Pick<UserRow, "id" | "suspended_at">>("SELECT id, suspended_at FROM users WHERE username = $1", [
    partnerUsername,
  ]);
  if (!partner || partner.suspended_at) throw new HttpError(404, "We couldn't find that person");
  if (partner.id === me) throw new HttpError(400, "Choose someone else — this takes two people");
  if (await involvement(me)) throw new HttpError(409, "You already have a relationship status. Remove it first to start a new one");
  if (await involvement(partner.id)) throw new HttpError(409, `@${partnerUsername} already has a relationship status`);
  const [row] = await db.query<RelationshipRow>(
    `INSERT INTO relationships (requester_id, partner_id, label) VALUES ($1, $2, $3)
     RETURNING id, requester_id, partner_id, label, status, created_at`,
    [me, partner.id, label],
  );
  const [full] = await db.query<RelationshipRow>(`${RELATIONSHIP_SELECT} WHERE r.id = $2`, [me, row!.id]);
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, body)
     VALUES ($1, $2, 'relationship', 'wants to share a relationship status with you. Only accept if you both agree.')`,
    [partner.id, me],
  );
  res.status(201).json(serializeRelationship(full!, me));
});

router.post("/me/relationship/:id/confirm", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const row = await one<RelationshipRow>(`${RELATIONSHIP_SELECT} WHERE r.id = $2 AND r.partner_id = $1 AND r.status = 'pending'`, [
    me,
    id,
  ]);
  if (!row) throw new HttpError(404, "That request doesn't exist or was withdrawn");
  // Confirming clears both solo labels: the partnership is now the single source of truth.
  await db.query("UPDATE relationships SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [id]);
  await db.query("UPDATE users SET relationship_label = NULL WHERE id = $1 OR id = $2", [row.requester_id, row.partner_id]);
  await db.query("DELETE FROM relationships WHERE partner_id = $1 AND status = 'pending' AND id <> $2", [me, id]);
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, body) VALUES ($1, $2, 'relationship', 'confirmed your relationship status. It now shows on both profiles.')`,
    [row.requester_id, me],
  );
  const [full] = await db.query<RelationshipRow>(`${RELATIONSHIP_SELECT} WHERE r.id = $2`, [me, id]);
  res.json(serializeRelationship(full!, me));
});

router.post("/me/relationship/:id/decline", requireAuth, async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const rows = await db.query<{ requester_id: string }>(
    "DELETE FROM relationships WHERE id = $1 AND partner_id = $2 AND status = 'pending' RETURNING requester_id",
    [id, me],
  );
  if (!rows.length) throw new HttpError(404, "That request doesn't exist or was withdrawn");
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, body) VALUES ($1, $2, 'relationship', 'didn’t confirm your relationship request. Nothing is shown on either profile.')`,
    [rows[0]!.requester_id, me],
  );
  res.status(204).end();
});

// Cancels your outgoing request, or removes a confirmed status (both sides, either person).
router.delete("/me/relationship", requireAuth, async (req, res) => {
  const me = viewer(req);
  const rows = await db.query<{ id: string; requester_id: string; partner_id: string; status: string }>(
    `DELETE FROM relationships WHERE (requester_id = $1 AND status = 'pending') OR ((requester_id = $1 OR partner_id = $1) AND status = 'confirmed')
     RETURNING id, requester_id, partner_id, status`,
    [me],
  );
  if (!rows.length) throw new HttpError(404, "You don't have a relationship status to remove");
  const row = rows[0]!;
  const otherId = row.requester_id === me ? row.partner_id : row.requester_id;
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, body) VALUES ($1, $2, 'relationship', $3)`,
    [
      otherId,
      me,
      row.status === "confirmed"
        ? "removed your shared relationship status. It no longer shows on either profile."
        : "withdrew their relationship request.",
    ],
  );
  res.status(204).end();
});
