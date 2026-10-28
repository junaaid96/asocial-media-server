import { db } from "../db.js";
import { fileUrl } from "../storage.js";

export interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  bio: string;
  institute: string;
  location: string;
  avatar_key: string | null;
  battery: string;
  letters_from: string;
  show_counts: boolean;
  role: "user" | "admin";
  suspended_at: Date | null;
  daily_limit_minutes: number | null;
  session_reminder_minutes: number | null;
  last_seen_at: Date | null;
  verified_at: Date | null;
  verified_label: string | null;
  relationship_label: string | null;
  created_at: Date;
}

export const USER_COLUMNS = `id, email, username, display_name, bio, institute, location, avatar_key,
  battery, letters_from, show_counts, role, suspended_at, daily_limit_minutes, session_reminder_minutes, last_seen_at,
  verified_at, verified_label, relationship_label, created_at`;

/** Columns every author-shaped SELECT must carry so badges stay accurate. */
export const VERIFIED_COLUMNS = `verified_at, verified_label, role`;

export type VerifiedPick = Pick<UserRow, "verified_at" | "verified_label" | "role">;

/** Moderators are verified by default; everyone else needs an explicit verification. */
export function isVerified(row: Pick<UserRow, "verified_at" | "role">): boolean {
  return !!row.verified_at || row.role === "admin";
}

export function publicUser(row: Pick<UserRow, "username" | "display_name" | "avatar_key" | "battery"> & VerifiedPick) {
  const verified = isVerified(row);
  return {
    username: row.username,
    displayName: row.display_name,
    avatarUrl: fileUrl(row.avatar_key),
    battery: row.battery,
    verified,
    verifiedLabel: verified ? row.verified_label : null,
  };
}

export function profileUser(row: UserRow) {
  return {
    ...publicUser(row),
    bio: row.bio,
    institute: row.institute,
    location: row.location,
    lettersFrom: row.letters_from,
    joinedAt: row.created_at,
  };
}

/** The signed-in user's own record, including private settings. */
export function selfUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    ...profileUser(row),
    showCounts: row.show_counts,
    role: row.role,
    suspended: !!row.suspended_at,
    dailyLimitMinutes: row.daily_limit_minutes,
    sessionReminderMinutes: row.session_reminder_minutes,
    relationshipLabel: row.relationship_label,
  };
}

export const PARTNERED_LABELS = ["in_a_relationship", "engaged", "married", "partnered"] as const;
export type PartneredLabel = (typeof PARTNERED_LABELS)[number];

/**
 * What a profile shows for relationship status: the solo label ("single"),
 * a confirmed partnership (label + partner), or nothing. Pending requests are
 * never shown — both people must confirm first.
 */
export async function fetchRelationship(userId: string) {
  const [solo] = await db.query<{ relationship_label: string | null }>(
    "SELECT relationship_label FROM users WHERE id = $1",
    [userId],
  );
  const [row] = await db.query<
    {
      label: string;
      username: string;
      display_name: string;
      avatar_key: string | null;
      battery: string;
    } & VerifiedPick
  >(
    `SELECT r.label, u.username, u.display_name, u.avatar_key, u.battery,
            u.verified_at, u.verified_label, u.role
     FROM relationships r
     JOIN users u ON u.id = CASE WHEN r.requester_id = $1 THEN r.partner_id ELSE r.requester_id END
     WHERE (r.requester_id = $1 OR r.partner_id = $1) AND r.status = 'confirmed'
       AND u.suspended_at IS NULL
     LIMIT 1`,
    [userId],
  );
  if (row) return { label: row.label, partner: publicUser(row) };
  if (solo?.relationship_label) return { label: solo.relationship_label, partner: null };
  return null;
}

/** Presence window: someone counts as "here" if a live socket or a recent heartbeat says so. */
export const PRESENCE_WINDOW_MS = 150_000;

export function isRecentlyActive(lastSeenAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - new Date(lastSeenAt).getTime() < PRESENCE_WINDOW_MS;
}
