-- Applied on every boot; all statements are idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id         SERIAL      PRIMARY KEY,
  slug       TEXT        NOT NULL UNIQUE,
  name       TEXT        NOT NULL,
  owner_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An attendance log rather than a permission list: any signed-in user can join
-- a room, and this records who was in it and when.
CREATE TABLE IF NOT EXISTS room_visits (
  id       SERIAL      PRIMARY KEY,
  room_id  INTEGER     NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_visits_room_idx ON room_visits (room_id, joined_at DESC);
