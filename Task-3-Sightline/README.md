# Sightline

A collaborative project board, built for the CodeAlpha Full Stack Development
internship (Task 3). It covers the optional real-time extra: everyone looking
at a board sees changes as they happen, over WebSockets.

## Features

- Registration and sign-in with a bcrypt-hashed password and an httpOnly session cookie
- Projects with members; the owner adds anyone by their registered email
- A four column board: to do, in progress, in review, done
- Task cards with a title, details, assignee, and a discussion thread
- Drag and drop between columns *and* within a column, moved optimistically and
  rolled back if the server refuses
- Live updates: a card another member moves, edits, deletes, or comments on
  appears on your board without a refresh
- Notifications: being given a task or being added to a project puts a row in
  your alerts, with an unread count in the header that arrives live

## Real-time design

The WebSocket server shares the session cookie and the JWT check with the HTTP
side, so an unauthenticated socket is closed on upgrade with code 4001. Board
membership is checked against the database before a socket joins a room, and the
close listener is registered before that check runs, so a client that gives up
mid-handshake is never left in the room.

Events go to every socket on the board, including the ones belonging to whoever
caused the change, because someone with the board open in two tabs needs both to
update. Each event carries an `actorId`: the id of the *browser tab* that made
the request, not the person. A tab ignores the echo of its own change, because
it already has the same state from its own HTTP response — but the same person's
second tab still applies it. Broadcasts are sent after the response has gone
out, so the reply always wins the race against the echo.

`task.created` and `task.updated` are separate events, so a bystander is told
the right thing happened. `task.removed` carries the title. Posting a comment
also broadcasts the task, because the card's comment count is part of it.

After a reconnect the client re-fetches the board and the roster before the
indicator goes back to green: events sent while the socket was down went to a
socket that no longer existed and are not replayed.

## Ordering

`position` is never set from the client. A drop sends the column and the new
order of task ids to `PUT /api/projects/:id/tasks/order`, which renumbers that
column inside one transaction, under an advisory lock keyed on the column. A
`UNIQUE (project_id, status, position)` constraint — deferred, because
renumbering swaps values around — is the backstop. Two people dropping into the
same column at the same moment can no longer both write the same position from
stale snapshots.

## Access control

Membership is verified per request in `server/members.js`, so a crafted project
id in the URL returns 404 rather than someone else's board. `isMember()` there
is the only copy of that query; the HTTP routes and the WebSocket handshake both
call it.

The role is enforced, not decorative. Owners invite, remove people, rename and
delete the project. Anyone on the project can create, edit, move and comment on
tasks, and can delete the tasks they created; only the owner can delete somebody
else's.

The role that is enforced is the one in `project_members`. `projects.owner_id`
is written when a project is created and then never read: no authorisation
decision anywhere consults it. It records who started the project, and that is
all it does.

### There is no way to leave a project

Only the owner can remove anybody, and the owner cannot remove themselves — so
a member cannot leave a project, and cannot delete one either. In full:

| Who | Doing what | Answer |
| --- | --- | --- |
| A member | Removing the owner | 403 |
| A member | Removing themselves | 403 |
| A member | Deleting the project | 403 |
| The owner | Removing themselves | 400 |

The owner can remove any member, and can delete the whole project. Everyone
else is on it until the owner acts.

There is also no account deletion — no endpoint anywhere deletes a user. This
is deliberate for something at this size: leaving is the kind of thing that
wants a confirmation flow and a decision about what happens to the leaver's
tasks and comments, and half of that is worse than none. It is written down
here because "no button for it" and "not thought about" look identical from
the outside, and this is the first.

## Columns

The four column keys are defined once, in `server/statuses.js`. `db.js` renders
the schema's CHECK constraint from that list, the routes validate against it,
and the browser asks `GET /api/columns` to build both the board and the task
dialog's Column dropdown. Adding a column is a one-file change.

## Tech stack

- Frontend: HTML, CSS, vanilla JavaScript, native drag and drop (no build step)
- Backend: Node.js, Express, ws
- Database: PostgreSQL
- Docker Compose for local setup

## Running it

Requires Docker Desktop.

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Open http://localhost:4002. To see the live updates, register two accounts,
add the second one to a project from the People dialog, and open the same board
in two browser windows.

## Layout

```
server/index.js            express app, http server, error handling
server/config.js           required environment, checked at boot
server/db.js               pool, schema on boot, transaction and column-lock helpers
server/auth.js             register, sign in, sign out, shared token check
server/members.js          isMember, the route guards, task-to-project resolution
server/statuses.js         the board's columns, defined once
server/realtime.js         WebSocket rooms, broadcasts, per-person delivery
server/notifications.js    writing and pushing notification rows
server/queries/tasks.js    the task query and its mapper
server/routes/             projects, tasks, task comments, notifications, columns
public/js/board.js         the board, drag and drop, live handlers
public/js/comment-thread.js the discussion under a task
public/js/notifications.js the header badge and its panel
public/js/html.js          escaping and the markup built on it
public/js/format.js        relative times
public/js/chrome.js        top bar and toast
public/                    pages, css/
test/                      node --test suites, no database needed
db/schema.sql              tables and constraints
```

## Tests

```bash
npm install
npm test
```

The suite is aimed at the membership guard, because it is the access check for
everything on a board: that a member gets through with their role attached,
that a stranger gets 404 rather than 403, that a non-numeric id never reaches
the database, and — the one that keeps the refactor from coming undone — that
the membership query still exists in exactly one module.

`board-edges.test.js` covers the edges of a shared board: the owner cannot be
removed from their own project, removing a member unassigns their cards rather
than deleting them, a card cannot be assigned to somebody who has just left, a
reorder that collides is a 409 and not a 500 — while any other database error
still is a 500 — and a notification reaches every tab the same person has open,
tested over real WebSockets.

### Concurrency: `npm run test:pg`

The suite above answers queries by matching SQL against regular expressions.
That is the right tool for asking what a handler does, but it cannot be two
transactions at once: its "409 collision" test injects a fabricated `23505` and
never runs a second transaction at all. A 40% failure rate on concurrent
cross-column reorders sat underneath it, undetected.

`test-pg/` holds the tests that need a real PostgreSQL, and is opt-in:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npm run test:pg
```

Twenty pairs of reorders on two different columns at once, which must all
return 200 with no deadlock — restoring the old two-statement locking fails 6
of 40 — and a burst of sixty into one column, after which positions must be
contiguous from 1. Without `TEST_DATABASE_URL` both skip with a message. Point
it at a scratch database; they write to it.
