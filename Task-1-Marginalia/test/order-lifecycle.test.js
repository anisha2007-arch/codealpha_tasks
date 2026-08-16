const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withApp } = require('./live-app');

// An order's whole life, against a real SQLite database running the real
// schema: what it refuses to become, what a second cancel does to stock, and
// what happens when the catalogue changes under a basket that is already full.

const APP = path.join(__dirname, '..');
const ADDRESS = { name: 'Ann Reader', line1: '1 High Street', city: 'Leeds', postcode: 'LS1' };

function app(run) {
  return withApp({
    appDir: APP,
    mounts: [['/api/orders', '../server/routes/orders'], ['/api/books', '../server/routes/books']],
  }, run);
}

async function seedUser(db) {
  await db.query(
    'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3)',
    ['Ann', 'ann@example.com', 'x']
  );
}

async function place(call, items) {
  return call('/api/orders', { method: 'POST', body: { items, address: ADDRESS } });
}

test('a delivered order is the end of the line: nothing moves it', async () => {
  await app(async ({ call, db, seen }) => {
    await seedUser(db);
    const placed = await place(call, [{ id: 1, quantity: 1 }]);
    assert.equal(placed.status, 201);
    const id = placed.body.id;

    // Placed -> Paid -> Shipped -> Delivered, each a legal step.
    for (const next of ['Paid', 'Shipped', 'Delivered']) {
      const step = await call(`/api/orders/${id}/status`, { method: 'POST', body: { status: next } });
      assert.equal(step.status, 200, `${next} should be allowed`);
      assert.equal(step.body.status, next);
    }

    // And now nothing at all is allowed, including the one that looks harmless.
    for (const next of ['Placed', 'Paid', 'Shipped', 'Delivered', 'Cancelled']) {
      const after = await call(`/api/orders/${id}/status`, { method: 'POST', body: { status: next } });
      assert.equal(after.status, 409, `${next} after Delivered should be refused`);
    }

    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [id]);
    assert.equal(rows[0].status, 'Delivered');
  });
});

test('a cancelled order is equally final', async () => {
  await app(async ({ call, db, seen }) => {
    await seedUser(db);
    const id = (await place(call, [{ id: 1, quantity: 1 }])).body.id;

    assert.equal((await call(`/api/orders/${id}/status`, { method: 'POST', body: { status: 'Cancelled' } })).status, 200);

    for (const next of ['Placed', 'Paid', 'Shipped', 'Delivered', 'Cancelled']) {
      const after = await call(`/api/orders/${id}/status`, { method: 'POST', body: { status: next } });
      assert.equal(after.status, 409, `${next} after Cancelled should be refused`);
    }
  });
});

// The bug this guards against is stock, not status: two cancels that both got
// through would put the copies back twice and inflate the catalogue.
test('cancelling twice restocks once', async () => {
  await app(async ({ call, db, seen }) => {
    await seedUser(db);

    const before = (await db.query('SELECT stock FROM books WHERE id = $1', [1])).rows[0].stock;
    const id = (await place(call, [{ id: 1, quantity: 3 }])).body.id;

    const afterOrder = (await db.query('SELECT stock FROM books WHERE id = $1', [1])).rows[0].stock;
    assert.equal(afterOrder, before - 3, 'placing the order takes the copies');

    // The double-click: two cancels with nothing awaited between them.
    const [first, second] = await Promise.all([
      call(`/api/orders/${id}/status`, { method: 'POST', body: { status: 'Cancelled' } }),
      call(`/api/orders/${id}/status`, { method: 'POST', body: { status: 'Cancelled' } }),
    ]);

    const codes = [first.status, second.status].sort();
    assert.deepEqual(codes, [200, 409], 'one cancel wins, the other is told it already happened');

    const restocked = (await db.query('SELECT stock FROM books WHERE id = $1', [1])).rows[0].stock;
    assert.equal(restocked, before, 'the copies come back exactly once');

    // SQLite runs these one after another, so what is proved above is that the
    // state machine refuses the second cancel. Under Postgres the second one
    // could arrive while the first is still open, and what stops it then is the
    // row lock — assert the query still asks for it, since the adapter strips
    // FOR UPDATE and would otherwise hide its removal.
    const locked = seen.some((q) => /SELECT \* FROM orders WHERE id = .* FOR UPDATE/.test(q.sql));
    assert.ok(locked, 'the order row is selected FOR UPDATE before the status is read');
  });
});

test('a book deleted while it sat in the basket is a 400, not a 500', async () => {
  await app(async ({ call, db, seen }) => {
    await seedUser(db);

    const before = (await db.query('SELECT stock FROM books WHERE id = $1', [1])).rows[0].stock;

    // The shopper added it, then it went out of the catalogue.
    await db.query('DELETE FROM books WHERE id = $1', [2]);

    const placed = await place(call, [{ id: 1, quantity: 1 }, { id: 2, quantity: 1 }]);
    assert.equal(placed.status, 400);
    assert.match(placed.body.error, /no longer available/i);

    // And nothing was taken from the book that is still there.
    const { rows } = await db.query('SELECT stock FROM books WHERE id = $1', [1]);
    assert.equal(rows[0].stock, before, 'a refused order deducts nothing at all');

    const orders = await db.query('SELECT count(*) AS n FROM orders');
    assert.equal(Number(orders.rows[0].n), 0, 'and writes no order row');
  });
});

// Same class of bug as the one fixed in Sightline: Number.isInteger(1e30) is
// true, so the value used to reach the query and come back as "invalid input
// syntax for type integer" — a 500 for what is plainly a bad request.
test('an id too large for a Postgres integer never reaches a query', async () => {
  await app(async ({ call, db, seen }) => {
    await seedUser(db);

    const fetched = await call('/api/orders/1e30');
    assert.equal(fetched.status, 404, 'reading it is a 404, the same as any order that is not yours');

    const moved = await call('/api/orders/1e30/status', { method: 'POST', body: { status: 'Paid' } });
    assert.equal(moved.status, 404);

    const placed = await place(call, [{ id: 1e30, quantity: 1 }]);
    assert.equal(placed.status, 400, 'and a basket holding one is malformed');
    assert.match(placed.body.error, /empty or malformed/i);

    const queried = seen.filter((q) => /1e\+30/.test(JSON.stringify(q.params)));
    assert.deepEqual(queried, [], 'the value never got as far as the database');
  });
});

test('the boundary itself is still a usable id', async () => {
  const { readOrderId, readLines, MAX_ID } = require('../server/order-input');

  assert.equal(readOrderId({ id: String(MAX_ID) }), MAX_ID);
  assert.equal(readOrderId({ id: String(MAX_ID + 1) }), null);
  assert.equal(readOrderId({ id: '1e30' }), null);
  assert.equal(readOrderId({ id: '7' }), 7);

  assert.deepEqual(readLines({ items: [{ id: MAX_ID, quantity: 1 }] }).lines, [{ id: MAX_ID, quantity: 1 }]);
  assert.ok(readLines({ items: [{ id: MAX_ID + 1, quantity: 1 }] }).error);
});
