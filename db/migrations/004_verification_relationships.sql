-- aSocial v2.3: verified members (admin-approved, badge on profile) and
-- relationship status (partnered statuses need both people to confirm).
-- Additive only: new nullable columns, two new tables, widened CHECK constraints.

-- Verification ------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS verified_label text CHECK (char_length(verified_label) <= 40);

-- Moderators are verified by default.
UPDATE users SET verified_at = coalesce(verified_at, now()) WHERE role = 'admin';

-- People can ask to be verified; moderators approve or reject each request.
CREATE TABLE IF NOT EXISTS verification_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL
);
-- One open request per person; after a decision they may ask again.
CREATE UNIQUE INDEX IF NOT EXISTS verification_requests_open_unique
  ON verification_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS verification_requests_status_idx
  ON verification_requests (status, created_at DESC);

-- Relationship status ------------------------------------------------------
-- Solo label, shown immediately. Only "single" lives here; partnered labels
-- come from a confirmed row in relationships so both sides always agree.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS relationship_label text CHECK (relationship_label IN ('single'));

CREATE TABLE IF NOT EXISTS relationships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  partner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label        text NOT NULL CHECK (label IN ('in_a_relationship', 'engaged', 'married', 'partnered')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK (requester_id <> partner_id)
);
CREATE INDEX IF NOT EXISTS relationships_requester_idx ON relationships (requester_id, status);
CREATE INDEX IF NOT EXISTS relationships_partner_idx ON relationships (partner_id, status);

-- Notifications for verification outcomes and relationship requests --------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('reaction', 'comment', 'follow', 'letter', 'mention', 'comment_reaction', 'report_update', 'moderation', 'verification', 'relationship'));

-- Audit trail for verification decisions -----------------------------------
ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN ('suspend_user', 'unsuspend_user', 'hide_post', 'unhide_post', 'resolve_report', 'dismiss_report', 'verify_user', 'unverify_user'));
