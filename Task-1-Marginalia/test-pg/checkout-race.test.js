const test = require('node:test');
const assert = require('node:assert/strict');

const { skip, withApp, marker } = require('./pg-harness');

// Two things the SQLite suite cannot see, because SQLite serialises writes and
// has neither row locks nor deadlock detection:
//
//   1. Checkout sorts its cart lines by id so every transaction takes book
//      locks in one order. Without that, two shoppers buying the same two
//      books in opposite orders deadlock, and Postgres kills one of them.
//   2. Cancelling twice at the same moment must restock once. The order row is
//      locked first, so the second cancellation wakes to find it already
//      cancelled.
//
// Both are about what happens when two transactions overlap, which is exactly
// what an engine with a global write lock cannot demonstrate.

const MOUNTS = [['/api/orders', '../server/routes/orders']];

async function seed(db, tag) {
  const user = await db.query(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, 'x') RETURNING id`,
    [`Buyer ${tag}`, `${tag}@example.test`]
  );

  // Two books, so a cart can name them in either order.
  const books = await db.query(
    `INSERT INTO books (slug, title, author, genre, price, year, pages, blurb, stock)
     VALUES ($1, $2, 'A', 'G', 10.00, 2000, 100, 'b', 40),
            ($3, $4, 'A', 'G', 10.00, 2000, 100, 'b', 40)
     RETURNING id`,
    [`${tag}-one`, `One ${tag}`, `${tag}-two`, `Two ${tag}`]
  );

  return { userId: user.rows[0].id, ids: books.rows.map((r) => r.id).sort((a, b) => a - b) };
}

async function cleanup(db, tag, userId) {
  await db.query('DELETE FROM orders WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  await db.query('DELETE FROM books WHERE slug LIKE $1', [`${tag}-%`]);
}

const address = { name: 'A', line1: 'B', city: 'C', postcode: 'D' };

test('two carts holding the same books in opposite orders do not deadlock', { skip }, async () => {
  const tag = marker('checkout');

  await withApp({ mounts: MOUNTS }, async ({ call, db, signInAs }) => {
    const { userId, ids } = await seed(db, tag);
    signInAs(userId);

    try {
      const [low, high] = ids;
      const results = [];

      // Twenty pairs. Each pair sends the same two books in opposite orders,
      // which is the shape that deadlocks when the lock order is the client's.
      for (let round = 0; round < 20; round += 1) {
        const ascending = call('/api/orders', {
          method: 'POST',
          body: { items: [{ id: low, quantity: 1 }, { id: high, quantity: 1 }], address },
        });
        const descending = call('/api/orders', {
          method: 'POST',
          body: { items: [{ id: high, quantity: 1 }, { id: low, quantity: 1 }], address },
        });
        results.push(...await Promise.all([ascending, descending]));
      }

      const codes = {};
      for (const r of results) codes[r.status] = (codes[r.status] || 0) + 1;

      assert.deepEqual(codes, { 201: 40 }, `every checkout should succeed, got ${JSON.stringify(codes)}`);

      // 40 orders of one copy each, from 40 in stock.
      const after = await db.query('SELECT id, stock FROM books WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
      assert.deepEqual(after.rows.map((r) => r.stock), [0, 0], 'stock is exactly drawn down, never below');
    } finally {
      await cleanup(db, tag, (await db.query('SELECT id FROM users WHERE email = $1', [`${tag}@example.test`])).rows[0]?.id || 0);
    }
  });
});

test('cancelling the same order twice at once restocks once', { skip }, async () => {
  const tag = marker('cancel');

  await withApp({ mounts: MOUNTS }, async ({ call, db, signInAs }) => {
    const { userId, ids } = await seed(db, tag);
    signInAs(userId);

    try {
      const [low, high] = ids;
      let doubleRestocks = 0;

      for (let round = 0; round < 15; round += 1) {
        const placed = await call('/api/orders', {
          method: 'POST',
          body: { items: [{ id: low, quantity: 2 }, { id: high, quantity: 1 }], address },
        });
        assert.equal(placed.status, 201);

        const before = await db.query('SELECT id, stock FROM books WHERE id = ANY($1::int[]) ORDER BY id', [ids]);

        // Both tabs press Cancel at the same moment.
        const both = await Promise.all([
          call(`/api/orders/${placed.body.id}/status`, { method: 'POST', body: { status: 'Cancelled' } }),
          call(`/api/orders/${placed.body.id}/status`, { method: 'POST', body: { status: 'Cancelled' } }),
        ]);

        const ok = both.filter((r) => r.status === 200);
        const refused = both.filter((r) => r.status === 409);
        assert.equal(ok.length, 1, `exactly one cancellation wins, got ${JSON.stringify(both.map((r) => r.status))}`);
        assert.equal(refused.length, 1, 'and the other is told it is already cancelled');
        assert.match(refused[0].body.error, /already cancelled/i);

        const after = await db.query('SELECT id, stock FROM books WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
        const restocked = after.rows.map((r, i) => r.stock - before.rows[i].stock);
        if (restocked[0] !== 2 || restocked[1] !== 1) doubleRestocks += 1;
      }

      assert.equal(doubleRestocks, 0, 'every cancellation put back exactly what the order held, once');
    } finally {
      await cleanup(db, tag, (await db.query('SELECT id FROM users WHERE email = $1', [`${tag}@example.test`])).rows[0]?.id || 0);
    }
  });
});
