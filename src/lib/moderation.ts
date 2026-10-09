// Moderation feedback and audit trail: every moderator decision is logged, people who
// reported something hear back, and authors are told (with the reason) when their post is
// hidden or restored. Following the "statement of reasons" practice used by large platforms.
import { db } from "../db.js";

export type ModerationAction = "suspend_user" | "unsuspend_user" | "hide_post" | "unhide_post" | "resolve_report" | "dismiss_report";

export async function logAction(entry: {
  adminId: string;
  action: ModerationAction;
  targetUserId?: string | null;
  postId?: string | null;
  reportId?: string | null;
  note?: string | null;
}) {
  await db.query(
    `INSERT INTO moderation_actions (admin_id, action, target_user_id, post_id, report_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.adminId, entry.action, entry.targetUserId ?? null, entry.postId ?? null, entry.reportId ?? null, entry.note?.slice(0, 1000) || null],
  );
}

const REASON_LABEL: Record<string, string> = {
  spam: "spam",
  harassment: "harassment",
  hate: "hate",
  self_harm: "self-harm",
  sexual: "sexual content",
  violence: "violence",
  misinformation: "misinformation",
  impersonation: "impersonation",
  other: "something else",
};

export function reasonLabel(reason: string) {
  return REASON_LABEL[reason] ?? reason.replace("_", " ");
}

/** The text a reporter sees once their report is handled. Never names the moderator. */
export function reportOutcomeText(outcome: "hide_post" | "suspend_user" | "none" | "dismissed", reason: string) {
  const what = `your report about ${reasonLabel(reason)}`;
  switch (outcome) {
    case "hide_post":
      return `Thank you. We reviewed ${what} and hid the post.`;
    case "suspend_user":
      return `Thank you. We reviewed ${what} and suspended the account.`;
    case "none":
      return `Thank you. We reviewed ${what} and closed it.`;
    default:
      return `Thank you. We reviewed ${what}. It didn't break our guidelines, so nothing was removed. You can always block or mute someone.`;
  }
}

/** Tells each reporter what happened. Reports from deleted accounts are skipped. */
export async function notifyReporters(reports: { reporter_id: string | null; reason: string; post_id: string | null }[], outcome: Parameters<typeof reportOutcomeText>[0]) {
  for (const report of reports) {
    if (!report.reporter_id) continue;
    await db.query(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, body) VALUES ($1, NULL, 'report_update', NULL, $2)`,
      [report.reporter_id, reportOutcomeText(outcome, report.reason)],
    );
  }
}

/** Tells an author their post was hidden (with the reason) or restored. */
export async function notifyAuthor(postId: string, hidden: boolean, reason: string) {
  const text = hidden
    ? `A moderator hid one of your posts${reason ? `: ${reason}` : "."} Only you can still see it. If you think this was a mistake, contact the aSocial team.`
    : "A moderator restored one of your posts. It's visible again.";
  await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, body)
     SELECT author_id, NULL, 'moderation', id, $2 FROM posts WHERE id = $1`,
    [postId, text.slice(0, 600)],
  );
}
