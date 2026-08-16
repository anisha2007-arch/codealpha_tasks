-- Applied on every boot; all statements are idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  handle        TEXT   NOT NULL UNIQUE,
  display_name  TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  bio           TEXT   NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS circles (
  id          SERIAL PRIMARY KEY,
  slug        TEXT   NOT NULL UNIQUE,
  name        TEXT   NOT NULL,
  description TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, circle_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id         SERIAL      PRIMARY KEY,
  author_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  circle_id  INTEGER     REFERENCES circles(id) ON DELETE SET NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL      PRIMARY KEY,
  post_id    INTEGER     NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

-- A row here means follower_id follows followee_id. The CHECK keeps anyone
-- from following themselves.
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author_id);
CREATE INDEX IF NOT EXISTS posts_circle_idx ON posts (circle_id);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id);

INSERT INTO circles (slug, name, description) VALUES
('reading', 'Reading Room', 'What everyone is part way through, and whether it is worth finishing.'),
('kitchen', 'The Kitchen', 'Cooking that went right, cooking that went badly wrong.'),
('walks', 'Long Walks', 'Routes, weather, and the things you notice on foot.'),
('desk', 'At the Desk', 'Work, side projects, and the slow parts in between.'),
('film', 'Late Screening', 'Films seen after midnight and the arguments that follow.')
ON CONFLICT (slug) DO NOTHING;
