-- aSocial v2 schema: a calm social space for introverts.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  username      text NOT NULL CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  password_hash text NOT NULL,
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  bio           text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 280),
  institute     text NOT NULL DEFAULT '' CHECK (char_length(institute) <= 80),
  location      text NOT NULL DEFAULT '' CHECK (char_length(location) <= 80),
  avatar_key    text,
  -- Social battery: lets others know how much interaction you have in you today.
  battery       text NOT NULL DEFAULT 'full' CHECK (battery IN ('full', 'half', 'low', 'recharging')),
  -- Who may send you letters.
  letters_from  text NOT NULL DEFAULT 'everyone' CHECK (letters_from IN ('everyone', 'following', 'nobody')),
  -- Quiet counts: reaction totals on your posts are private unless you opt in.
  show_counts   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_key ON users (username);

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body            text NOT NULL DEFAULT '' CHECK (char_length(body) <= 3000),
  image_key       text,
  mood            text CHECK (mood IN ('calm', 'reflective', 'joyful', 'grateful', 'tired', 'anxious', 'curious', 'melancholy')),
  content_warning text CHECK (char_length(content_warning) <= 80),
  is_anonymous    boolean NOT NULL DEFAULT false,
  prompt_date     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  search          tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  CHECK (body <> '' OR image_key IS NOT NULL)
);
CREATE INDEX posts_created_idx ON posts (created_at DESC, id DESC);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC);
CREATE INDEX posts_mood_idx ON posts (mood, created_at DESC) WHERE mood IS NOT NULL;
CREATE INDEX posts_prompt_idx ON posts (prompt_date, created_at DESC) WHERE prompt_date IS NOT NULL;
CREATE INDEX posts_search_idx ON posts USING gin (search);

-- Gentle reactions instead of likes. One reaction per person per post.
CREATE TABLE reactions (
  post_id    uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('felt', 'hug', 'insight', 'relate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX reactions_user_idx ON reactions (user_id);

CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);

CREATE TABLE bookmarks (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- Letters: slow, pen-pal style messages that arrive after a delay.
CREATE TABLE letters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reply_to     uuid REFERENCES letters (id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deliver_at   timestamptz NOT NULL,
  read_at      timestamptz,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX letters_recipient_idx ON letters (recipient_id, deliver_at DESC);
CREATE INDEX letters_sender_idx ON letters (sender_id, created_at DESC);

-- created_at is when the notification becomes visible (letters notify on arrival).
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users (id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('reaction', 'comment', 'follow', 'letter')),
  post_id    uuid REFERENCES posts (id) ON DELETE CASCADE,
  letter_id  uuid REFERENCES letters (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
