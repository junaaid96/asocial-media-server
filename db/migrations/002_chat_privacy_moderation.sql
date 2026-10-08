-- aSocial v2.1: chat, post privacy, comment reactions, tags, moderation and time tracking.
-- Additive only: new tables, new nullable/defaulted columns, and a widened CHECK constraint.

-- Roles, moderation and wellbeing settings on users -------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role               text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  ADD COLUMN IF NOT EXISTS suspended_at       timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason   text CHECK (char_length(suspended_reason) <= 500),
  ADD COLUMN IF NOT EXISTS daily_limit_minutes integer CHECK (daily_limit_minutes IS NULL OR daily_limit_minutes BETWEEN 5 AND 1440),
  ADD COLUMN IF NOT EXISTS last_seen_at       timestamptz;

-- Post privacy and moderation ----------------------------------------------
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers', 'private')),
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_reason text CHECK (char_length(hidden_reason) <= 500);
CREATE INDEX IF NOT EXISTS posts_visibility_idx ON posts (visibility) WHERE visibility <> 'public';

-- Hashtags, extracted from post bodies on write.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag     text NOT NULL CHECK (tag ~ '^[a-z0-9_]{1,50}$'),
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS post_tags_tag_idx ON post_tags (tag);

-- Reactions on replies: same gentle set as posts, one per person per reply.
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id uuid NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('felt', 'hug', 'insight', 'relate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS comment_reactions_user_idx ON comment_reactions (user_id);

-- 1:1 chat ------------------------------------------------------------------
-- user_a < user_b so each pair has exactly one conversation.
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS conversations_user_b_idx ON conversations (user_b);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  client_id       text CHECK (char_length(client_id) <= 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON messages (conversation_id, sender_id) WHERE read_at IS NULL;
-- Lets a client safely retry a send after a dropped connection.
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_key ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;

-- Reports to moderators -----------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  target_type    text NOT NULL CHECK (target_type IN ('user', 'post', 'message')),
  target_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  post_id        uuid REFERENCES posts (id) ON DELETE SET NULL,
  message_id     uuid REFERENCES messages (id) ON DELETE SET NULL,
  -- Snapshot of the reported content, so moderators can still review it if it's edited or deleted.
  excerpt        text CHECK (char_length(excerpt) <= 2000),
  reason         text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'self_harm', 'sexual', 'violence', 'misinformation', 'impersonation', 'other')),
  details        text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  action         text CHECK (action IN ('none', 'hide_post', 'suspend_user')),
  resolution_note text CHECK (char_length(resolution_note) <= 1000),
  resolved_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);
-- One open report per person per target.
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_unique ON reports (reporter_id, target_type, coalesce(post_id, message_id, target_user_id))
  WHERE status = 'open';

-- Time well spent: seconds of active use per user per local day ----------------
CREATE TABLE IF NOT EXISTS usage_days (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day     date NOT NULL,
  seconds integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  PRIMARY KEY (user_id, day)
);

-- Notifications: mentions and reply reactions ---------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id uuid REFERENCES comments (id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('reaction', 'comment', 'follow', 'letter', 'mention', 'comment_reaction'));
