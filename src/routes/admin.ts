import { Router } from "express";
import { z } from "zod";
import { forgetAccountState, requireAdmin, viewer } from "../auth.js";
import { db, one } from "../db.js";
import { decodeCursor, encodeCursor, pageLimit } from "../lib/cursor.js";
import { HttpError, idParam, notFound, parse } from "../lib/http.js";
import { plainExcerpt } from "../lib/richtext.js";
import { publicUser } from "../lib/users.js";

export const router = Router();
router.use(requireAdmin);

// --- Dashboard ----------------------------------------------------------------

router.get("/stats", async (_req, res) => {
  const [totals] = await db.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS users_7d,
       (SELECT count(*)::int FROM users WHERE suspended_at IS NOT NULL) AS suspended,
       (SELECT count(*)::int FROM users WHERE role = 'admin') AS admins,
       (SELECT count(*)::int FROM posts) AS posts,
       (SELECT count(*)::int FROM posts WHERE created_at > now() - interval '7 days') AS posts_7d,
       (SELECT count(*)::int FROM posts WHERE hidden_at IS NOT NULL) AS hidden_posts,
       (SELECT count(*)::int FROM comments) AS comments,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM messages WHERE created_at > now() - interval '7 days') AS messages_7d,
       (SELECT count(*)::int FROM reports WHERE status = 'open') AS open_reports,
       (SELECT count(*)::int FROM reports) AS reports,
       (SELECT count(DISTINCT user_id)::int FROM usage_days WHERE day >= (now() - interval '1 day')::date) AS active_today,
       (SELECT count(DISTINCT user_id)::int FROM usage_days WHERE day >= (now() - interval '7 days')::date) AS active_7d`,
  );
  const series = await db.query<{ day: string; signups: number; posts: number; messages: number; active: number }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT count(*)::int FROM users WHERE created_at::date = d) AS signups,
       (SELECT count(*)::int FROM posts WHERE created_at::date = d) AS posts,
       (SELECT count(*)::int FROM messages WHERE created_at::date = d) AS messages,
       (SELECT count(*)::int FROM usage_days WHERE day = d) AS active
     FROM generate_series((now() - interval '13 days')::date, now()::date, interval '1 day') AS g(d)
     ORDER BY d`,
  );
  res.json({ totals, series });
});

// --- Users --------------------------------------------------------------------

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  battery: string;
  email: string;
  role: string;
  created_at: Date;
  suspended_at: Date | null;
  suspended_reason: string | null;
  last_seen_at: Date | null;
  posts: number;
  reports_against: number;
}

const usersQuery = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["all", "suspended", "admins"]).default("all"),
});

router.get("/users", async (req, res) => {
  const { q, status } = parse(usersQuery, req.query);
  const cursor = decodeCursor(req.query.cursor);
  const limit = pageLimit(req.query.limit, 25, 100);
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where: string[] = [];
  if (q) {
    const like = add(`%${q.replace(/^@/, "").replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(u.username ILIKE ${like} OR u.display_name ILIKE ${like} OR u.email ILIKE ${like})`);
  }
  if (status === "suspended") where.push("u.suspended_at IS NOT NULL");
  if (status === "admins") where.push("u.role = 'admin'");
  if (cursor) where.push(`(u.created_at, u.id) < (${add(cursor.t)}::timestamptz, ${add(cursor.id)}::uuid)`);
  const rows = await db.query<AdminUserRow>(
    `SELECT u.id, u.username, u.display_name, u.avatar_key, u.battery, u.email, u.role, u.created_at,
            u.suspended_at, u.suspended_reason, u.last_seen_at,
            (SELECT count(*)::int FROM posts p WHERE p.author_id = u.id) AS posts,
            (SELECT count(*)::int FROM reports r WHERE r.target_user_id = u.id) AS reports_against
     FROM users u ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY u.created_at DESC, u.id DESC LIMIT ${add(limit + 1)}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  res.json({
    items: page.map((row) => ({
      id: row.id,
      ...publicUser(row),
      email: row.email,
      role: row.role,
      joinedAt: row.created_at,
      suspendedAt: row.suspended_at,
      suspendedReason: row.suspended_reason,
      lastSeenAt: row.last_seen_at,
      posts: row.posts,
      reportsAgainst: row.reports_against,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  });
});

const reasonSchema = z.object({ reason: z.string().trim().max(500).default("") });

async function suspendUser(id: string, adminId: string, reason: string) {
  const user = await one<{ role: string }>("SELECT role FROM users WHERE id = $1", [id]);
  if (!user) throw notFound("That person doesn't exist");
  if (id === adminId) throw new HttpError(400, "You can't suspend yourself");
  if (user.role === "admin") throw new HttpError(400, "Demote this admin before suspending them");
  await db.query("UPDATE users SET suspended_at = coalesce(suspended_at, now()), suspended_reason = $2 WHERE id = $1", [id, reason || null]);
  forgetAccountState(id);
}

router.post("/users/:id/suspend", async (req, res) => {
  const { reason } = parse(reasonSchema, req.body ?? {});
  await suspendUser(idParam(req), viewer(req), reason);
  res.json({ suspended: true });
});

router.post("/users/:id/unsuspend", async (req, res) => {
  const id = idParam(req);
  await db.query("UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1", [id]);
  forgetAccountState(id);
  res.json({ suspended: false });
});

// --- Posts --------------------------------------------------------------------

const postsQuery = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["all", "hidden", "reported"]).default("all"),
});

router.get("/posts", async (req, res) => {
  const { q, status } = parse(postsQuery, req.query);
  const cursor = decodeCursor(req.query.cursor);
  const limit = pageLimit(req.query.limit, 25, 100);
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where: string[] = [];
  if (q) where.push(`(p.search @@ websearch_to_tsquery('english', ${add(q)}) OR u.username = ${add(q.replace(/^@/, "").toLowerCase())})`);
  if (status === "hidden") where.push("p.hidden_at IS NOT NULL");
  if (status === "reported") where.push("EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id AND r.status = 'open')");
  if (cursor) where.push(`(p.created_at, p.id) < (${add(cursor.t)}::timestamptz, ${add(cursor.id)}::uuid)`);
  const rows = await db.query<{
    id: string;
    body: string;
    visibility: string;
    is_anonymous: boolean;
    created_at: Date;
    hidden_at: Date | null;
    hidden_reason: string | null;
    username: string;
    display_name: string;
    avatar_key: string | null;
    battery: string;
    author_id: string;
    open_reports: number;
  }>(
    `SELECT p.id, p.body, p.visibility, p.is_anonymous, p.created_at, p.hidden_at, p.hidden_reason, p.author_id,
            u.username, u.display_name, u.avatar_key, u.battery,
            (SELECT count(*)::int FROM reports r WHERE r.post_id = p.id AND r.status = 'open') AS open_reports
     FROM posts p JOIN users u ON u.id = p.author_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY p.created_at DESC, p.id DESC LIMIT ${add(limit + 1)}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  res.json({
    items: page.map((row) => ({
      id: row.id,
      excerpt: plainExcerpt(row.body, 240),
      visibility: row.visibility,
      isAnonymous: row.is_anonymous,
      createdAt: row.created_at,
      hiddenAt: row.hidden_at,
      hiddenReason: row.hidden_reason,
      // Moderators see who wrote anonymous posts: that's needed to act on abuse.
      author: { id: row.author_id, ...publicUser(row) },
      openReports: row.open_reports,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  });
});

async function hidePost(id: string, reason: string) {
  const rows = await db.query("UPDATE posts SET hidden_at = coalesce(hidden_at, now()), hidden_reason = $2 WHERE id = $1 RETURNING 1", [
    id,
    reason || null,
  ]);
  if (!rows.length) throw notFound("That post no longer exists");
}

router.post("/posts/:id/hide", async (req, res) => {
  const { reason } = parse(reasonSchema, req.body ?? {});
  await hidePost(idParam(req), reason);
  res.json({ hidden: true });
});

router.post("/posts/:id/unhide", async (req, res) => {
  await db.query("UPDATE posts SET hidden_at = NULL, hidden_reason = NULL WHERE id = $1", [idParam(req)]);
  res.json({ hidden: false });
});

// --- Reports ------------------------------------------------------------------

interface ReportRow {
  id: string;
  target_type: string;
  reason: string;
  details: string;
  excerpt: string | null;
  status: string;
  action: string | null;
  resolution_note: string | null;
  created_at: Date;
  resolved_at: Date | null;
  post_id: string | null;
  message_id: string | null;
  target_user_id: string | null;
  reporter_username: string | null;
  reporter_display_name: string | null;
  reporter_avatar_key: string | null;
  reporter_battery: string | null;
  target_username: string | null;
  target_display_name: string | null;
  target_avatar_key: string | null;
  target_battery: string | null;
  target_suspended: boolean;
  post_hidden: boolean | null;
  post_exists: boolean;
  resolver_username: string | null;
  reports_on_target: number;
}

router.get("/reports", async (req, res) => {
  const status = parse(z.enum(["open", "resolved", "dismissed", "all"]).default("open"), req.query.status);
  const rows = await db.query<ReportRow>(
    `SELECT r.id, r.target_type, r.reason, r.details, r.excerpt, r.status, r.action, r.resolution_note, r.created_at, r.resolved_at,
            r.post_id, r.message_id, r.target_user_id,
            rep.username AS reporter_username, rep.display_name AS reporter_display_name, rep.avatar_key AS reporter_avatar_key, rep.battery AS reporter_battery,
            t.username AS target_username, t.display_name AS target_display_name, t.avatar_key AS target_avatar_key, t.battery AS target_battery,
            coalesce(t.suspended_at IS NOT NULL, false) AS target_suspended,
            (SELECT p.hidden_at IS NOT NULL FROM posts p WHERE p.id = r.post_id) AS post_hidden,
            EXISTS (SELECT 1 FROM posts p WHERE p.id = r.post_id) AS post_exists,
            res.username AS resolver_username,
            (SELECT count(*)::int FROM reports o WHERE o.target_user_id = r.target_user_id) AS reports_on_target
     FROM reports r
     LEFT JOIN users rep ON rep.id = r.reporter_id
     LEFT JOIN users t ON t.id = r.target_user_id
     LEFT JOIN users res ON res.id = r.resolved_by
     ${status === "all" ? "" : "WHERE r.status = $1"}
     ORDER BY r.created_at ${status === "open" ? "ASC" : "DESC"} LIMIT 200`,
    status === "all" ? [] : [status],
  );
  const user = (u: string | null, d: string | null, a: string | null, b: string | null) =>
    u ? publicUser({ username: u, display_name: d!, avatar_key: a, battery: b! }) : null;
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      reason: row.reason,
      details: row.details,
      excerpt: row.excerpt,
      status: row.status,
      action: row.action,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolver_username,
      reporter: user(row.reporter_username, row.reporter_display_name, row.reporter_avatar_key, row.reporter_battery),
      target: {
        userId: row.target_user_id,
        user: user(row.target_username, row.target_display_name, row.target_avatar_key, row.target_battery),
        userSuspended: row.target_suspended,
        postId: row.post_exists ? row.post_id : null,
        postHidden: row.post_hidden,
        messageId: row.message_id,
        reportsOnTarget: row.reports_on_target,
      },
    })),
  });
});

const resolveSchema = z.object({
  action: z.enum(["none", "hide_post", "suspend_user"]).default("none"),
  note: z.string().trim().max(1000).default(""),
});

router.post("/reports/:id/resolve", async (req, res) => {
  const me = viewer(req);
  const id = idParam(req);
  const { action, note } = parse(resolveSchema, req.body ?? {});
  const report = await one<{ status: string; post_id: string | null; target_user_id: string | null; reason: string }>(
    "SELECT status, post_id, target_user_id, reason FROM reports WHERE id = $1",
    [id],
  );
  if (!report) throw notFound("That report doesn't exist");
  if (report.status !== "open") throw new HttpError(409, "That report was already handled");
  const why = note || `Reported for ${report.reason.replace("_", " ")}`;
  if (action === "hide_post") {
    if (!report.post_id) throw new HttpError(400, "This report isn't about a post");
    await hidePost(report.post_id, why);
  }
  if (action === "suspend_user") {
    if (!report.target_user_id) throw new HttpError(400, "The reported account no longer exists");
    await suspendUser(report.target_user_id, me, why);
  }
  // Resolving one report also closes other open reports about the same content.
  await db.query(
    `UPDATE reports SET status = 'resolved', action = $2, resolution_note = $3, resolved_by = $4, resolved_at = now()
     WHERE status = 'open' AND (id = $1 OR ($5::uuid IS NOT NULL AND post_id = $5::uuid) OR ($6 = 'suspend_user' AND target_user_id = $7::uuid))`,
    [id, action, note || null, me, action === "hide_post" ? report.post_id : null, action, report.target_user_id],
  );
  res.json({ status: "resolved", action });
});

router.post("/reports/:id/dismiss", async (req, res) => {
  const { note } = parse(z.object({ note: z.string().trim().max(1000).default("") }), req.body ?? {});
  const rows = await db.query(
    `UPDATE reports SET status = 'dismissed', action = 'none', resolution_note = $2, resolved_by = $3, resolved_at = now()
     WHERE id = $1 AND status = 'open' RETURNING 1`,
    [idParam(req), note || null, viewer(req)],
  );
  if (!rows.length) throw new HttpError(409, "That report was already handled");
  res.json({ status: "dismissed" });
});
