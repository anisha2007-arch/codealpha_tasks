# Marginalia

An online bookshop, built for the CodeAlpha Full Stack Development internship (Task 1).

## Features

- Catalogue with genre filters and a search across titles and authors
- Book pages with stock, blurb, and a quantity picker
- Basket kept in the browser, so you can shop before signing in
- Registration and sign-in with a bcrypt-hashed password and an httpOnly session cookie
- Checkout writes an order and decrements stock in one transaction, under a row
  lock, so the last copy cannot be sold twice
- Order processing: an order runs Placed → Paid → Shipped → Delivered, and can
  be cancelled while it is still Placed or Paid, which puts the copies back
- Order history, with the delivery address kept across the sign-in detour

Prices are always read from the database at checkout, never from the request
body, so a tampered basket cannot change what you are charged. The shipping rule
is served from `GET /api/shipping`, so the basket totals with the same numbers
checkout charges with.

Checkout locks its book rows in id order, having merged duplicate cart lines
first, so two baskets holding the same books in a different order queue behind
each other instead of deadlocking. A cart is capped at 50 different books and 99
copies of any one of them, to bound how long those locks are held. Cancellation
restocks under the same discipline: the order row is locked first, so two racing
cancellations cannot both put the stock back.

## Tech stack

- Frontend: HTML, CSS, vanilla JavaScript (no build step)
- Backend: Node.js, Express
- Database: PostgreSQL
- Docker Compose for local setup

## Running it

Requires Docker Desktop.

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Open http://localhost:4000.

## Layout

```
server/index.js       express app and error handling
server/config.js      required environment, checked at boot
server/db.js          connection pool, applies db/schema.sql on boot
server/auth.js        register, sign in, sign out, session middleware
server/shipping.js    the shipping rule, and the only copy of it
server/routes/        books and orders
public/js/api.js      fetch wrapper, current user, requireUser
public/js/html.js     escaping and the markup built on it
public/js/format.js   money
public/js/chrome.js   masthead, basket badge, toast
public/               pages, css/
test/                 node --test suites, no database needed
db/schema.sql         tables and the seed catalogue
```

Book covers are drawn in CSS from each title, so there are no image files to
keep in step with the catalogue.

## Tests

```bash
npm install
npm test
```

The checkout suite runs the real route against a stand-in for `server/db.js`,
so it covers the things that are load-bearing and easy to get wrong: that the
price charged comes from the catalogue and not from the request body, that the
shipping threshold is applied at the right boundary, and that a cart which runs
out of stock halfway through deducts nothing at all and rolls back.

`order-lifecycle.test.js` runs an order through its whole state machine against
an in-memory SQLite database holding the real schema: that Delivered and
Cancelled accept nothing further, that cancelling twice puts the copies back
exactly once, and that a book deleted while it sat in a basket is a 400 rather
than a 500.

`cart-store.test.js` runs the basket in a jsdom page, including the thing
localStorage makes easy to get wrong: signing out has to empty it, or the next
person to use that browser inherits it.

### Concurrency: `npm run test:pg`

SQLite serialises writes, so "cancelling twice puts the copies back once"
passes there whether or not the row lock that makes it true is present. The
two tests in `test-pg/` need a real PostgreSQL and are opt-in:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scratch npm run test:pg
```

They run twenty pairs of checkouts naming the same two books in opposite
orders — which deadlocks unless `readLines()` sorts the cart by id, and does:
removing the sort fails 19 of 40 — and fifteen rounds of two simultaneous
cancellations of one order, which must restock exactly once. Without
`TEST_DATABASE_URL` both skip with a message. Point it at a scratch database;
they write to it.
