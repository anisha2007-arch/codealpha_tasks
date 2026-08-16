-- Applied on every boot by server/db.js; all statements are idempotent.
--
-- This file is not run directly through psql: db.js fills the status
-- placeholder below in from server/statuses.js, so the CHECK constraint and
-- the board the browser draws can never disagree.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  owner_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membership is the access check for everything below: no row here means no
-- read and no write on the project. The role decides who may invite, remove
-- people, rename or delete the project, and delete other people's tasks.
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id),
  CHECK (role IN ('owner', 'member'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL      PRIMARY KEY,
  project_id  INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL DEFAULT '',
  status      TEXT        NOT NULL DEFAULT 'todo',
  assignee_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  -- Nullable and SET NULL, for the same reason assignee_id is: a task belongs
  -- to the board, not to whoever typed it. See the ALTER below, which is what
  -- moves an existing database onto this.
  created_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ({{STATUSES}}))
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         SERIAL      PRIMARY KEY,
  task_id    INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per thing that happened to somebody else: a task assigned to them,
-- or an invitation to a project. read_at NULL is what the header badge counts.
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL      PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  project_id INTEGER     REFERENCES projects(id) ON DELETE CASCADE,
  task_id    INTEGER     REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('task.assigned', 'project.invited'))
);

-- tasks.created_by was the one foreign key to users(id) with no delete clause,
-- so it defaulted to NO ACTION and deleting anybody who had ever created a
-- task was refused outright:
--
--   ERROR: update or delete on table "users" violates foreign key constraint
--          "tasks_created_by_fkey" on table "tasks"
--
-- Deleting a user who had only commented or been assigned worked, because
-- those columns say what they want. Nothing reaches this today — there is no
-- account deletion anywhere — but whoever adds one gets a 500 out of the
-- driver rather than a working delete, on a table they may not think to look
-- at.
--
-- SET NULL, matching assignee_id: a task belongs to the board rather than to
-- whoever typed it, and CASCADE here would delete other people's cards out of
-- a shared project. The column has to lose NOT NULL for that to be possible.
-- Both permission checks that read created_by compare it to a user id, so a
-- null fails them and leaves the task deletable by the project owner only,
-- which is the safe direction.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_created_by_fkey' AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE tasks ALTER COLUMN created_by DROP NOT NULL;
    ALTER TABLE tasks DROP CONSTRAINT tasks_created_by_fkey;
    ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id, status, position);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments (task_id);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Two cards may not share a slot in a column. Writers take an advisory lock per
-- column so they never collide in the first place; this is the backstop that
-- turns a missed lock into an error instead of a board that silently reorders
-- itself. It is DEFERRABLE because renumbering a column swaps positions around
-- and only the state at COMMIT has to be sound.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_column_position_key') THEN
    WITH ordered AS (
      SELECT id, row_number() OVER (PARTITION BY project_id, status ORDER BY position, id) AS rn
      FROM tasks
    )
    UPDATE tasks t SET position = ordered.rn
    FROM ordered WHERE ordered.id = t.id AND t.position <> ordered.rn;

    ALTER TABLE tasks ADD CONSTRAINT tasks_column_position_key
      UNIQUE (project_id, status, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
