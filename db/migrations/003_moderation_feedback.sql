-- aSocial v2.2: tell people what happened to their reports, keep a moderation audit log,
-- and let people choose a gentle "you've been here a while" reminder.
-- Additive only: one new table, new nullable columns and a widened CHECK constraint.

-- Session reminder: minutes of continuous use before a gentle nudge (NULL = off).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_reminder_minutes integer
    CHECK (session_reminder_minutes IS NULL OR session_reminder_minutes BETWEEN 5 AND 240);

-- System notifications (report outcomes, moderation notices) carry their own text.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body text CHECK (char_length(body) <= 600);
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('reaction', 'comment', 'follow', 'letter', 'mention', 'comment_reaction', 'report_update', 'moderation'));

-- Every moderator action, so decisions can be reviewed later.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  action         text NOT NULL CHECK (action IN ('suspend_user', 'unsuspend_user', 'hide_post', 'unhide_post', 'resolve_report', 'dismiss_report')),
  target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  post_id        uuid REFERENCES posts (id) ON DELETE SET NULL,
  report_id      uuid REFERENCES reports (id) ON DELETE SET NULL,
  note           text CHECK (char_length(note) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_created_idx ON moderation_actions (created_at DESC);
