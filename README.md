# CodeAlpha Projects

Full Stack Development internship tasks for CodeAlpha. All four are built on
the same stack: a vanilla HTML, CSS, and JavaScript frontend with no build
step, an Express API, and PostgreSQL.

| Task | Project | What it is | Port |
| --- | --- | --- | --- |
| 1. E-commerce store | [Marginalia](Task-1-Marginalia) | A bookshop with a basket, checkout, and order history | 4000 |
| 2. Social media platform | [Coterie](Task-2-Coterie) | Posts, comments, likes, follows, and topic circles | 4001 |
| 3. Project management tool | [Sightline](Task-3-Sightline) | A drag and drop board with live updates over WebSockets | 4002 |
| 4. Real-time communication | [Roundtable](Task-4-Roundtable) | WebRTC video, screen sharing, file transfer, and a shared whiteboard | 4003 |

## Running any of them

Each task is self-contained and needs Docker Desktop:

```bash
cd Task-1-Marginalia          # or any of the others
cp .env.example .env          # fill in the blanks
docker compose up --build
```

The ports differ, so more than one can run at the same time. Setup notes and
design decisions are in each project's own README.

## Running the tests

Every project has a suite on Node's built-in test runner:

```bash
cd Task-1-Marginalia          # or any of the others
npm install
npm test
```

That is the default suite, and it needs neither a database nor a browser.
Marginalia and Sightline have a second, opt-in tier that does — see below.

Three ways of standing in for a database or a browser, picked per test by what
the test is actually asking:

| Stand-in | Where | Why |
| --- | --- | --- |
| `test/sqlite-db.js` | Marginalia, Coterie | Puts an in-memory SQLite database behind a fake `pg`, so the **real** `db/schema.sql` and the **real** `server/db.js` run — pool, `init()`, transactions and all. UNIQUE, CHECK and `ON DELETE` genuinely fire, which is the point when the question is "does the constraint exist". |
| `fakeDb` in `test/helpers.js` | all four | Answers queries by pattern. Right when the question is about the handler — a status code, a query it should *not* issue, or an error code it has to translate. Sightline uses it throughout, because its schema adds a DEFERRABLE constraint from a PL/pgSQL `DO` block and SQLite has no honest equivalent. |
| `jsdom` (dev dependency) | Marginalia, Roundtable | A real DOM with real `localStorage` and real events, for the parts that only exist in the browser: the basket, the whiteboard, the screen share. |

Sightline and Roundtable also drive **real WebSockets against a real server** —
that is the only way to test what a second browser tab receives.

The SQLite stand-in translates a deliberately narrow slice of Postgres: the
dialect these apps actually use. Anything outside it fails loudly rather than
quietly running something different from production. It records the SQL the app
*wrote*, not the SQL it ran, so a test can still assert on `FOR UPDATE` or an
advisory lock that SQLite does not have.

### The second tier: `npm run test:pg`

Every stand-in above has one blind spot in common, and it is the same blind
spot: **none of them can be two transactions at once.** SQLite serialises
writes globally, and `fakeDb` answers by pattern, so a test that looks like it
covers a race is not evidence about Postgres — there are no row locks to take
in the wrong order and no deadlock detector to trip. Three real bugs sat under
a green suite for exactly that reason, including a 40% failure rate on
concurrent cross-column reorders.

So Marginalia and Sightline have a second, opt-in tier in `test-pg/`, for the
handful of paths where concurrency *is* the thing being tested:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npm run test:pg
```

| Test | What only a real database can show |
| --- | --- |
| Marginalia: two carts, same books, opposite order | Checkout sorts its lines so every transaction locks books in one order. Without the sort, 19 of 40 concurrent checkouts died with a deadlock. |
| Marginalia: cancelling the same order twice at once | The order row is locked first, so the second cancellation finds it already cancelled. Without the lock, both return 200 and the stock is put back twice. |
| Sightline: reorders on two columns at once | Different columns take different advisory locks, so only the row-lock order serialises them. Restoring the old two-statement version fails 6 of 40. |
| Sightline: a burst into one column | Positions come back contiguous from 1, with no duplicates. |

Each test is checked both ways: it passes against the current code, and it
fails when the protection it covers is taken out. A test that has never been
seen to fail is not yet evidence of anything.

Without `TEST_DATABASE_URL` these skip with a message saying what to set, so
`npm test` still needs nothing installed. Point it at a scratch database: the
tests write to it. Roundtable's whiteboard replay is checked in the ordinary
suite instead — the limit it has to respect is a message size, which can be
asserted without a real data channel.

## Shared conventions

- Sessions are a signed JWT in an httpOnly, sameSite cookie; passwords are
  stored as bcrypt hashes
- Secrets come from `.env` and are never committed
- Each app applies its own `db/schema.sql` on boot, and every statement in it
  is idempotent
- Prices, permissions, and ownership are checked on the server, never trusted
  from the browser

