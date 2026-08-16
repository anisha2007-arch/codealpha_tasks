const test = require('node:test');
const assert = require('node:assert/strict');

const { fakeDb, withRouter } = require('./helpers');
const { SHIPPING_FEE, FREE_SHIPPING_OVER } = require('../server/shipping');

const ADDRESS = { name: 'Ada Lovelace', line1: '1 Mill Lane', city: 'Bengaluru', postcode: '560001' };

// A catalogue the fake database will answer with, keyed by id.
function catalogue(overrides = {}) {
  const books = {
    1: { id: 1, slug: 'orlando', title: 'Orlando', author: 'Woolf', price: 400, stock: 5 },
    2: { id: 2, slug: 'dubliners', title: 'Dubliners', author: 'Joyce', price: 250, stock: 1 },
  };
  for (const [id, patch] of Object.entries(overrides)) Object.assign(books[id], patch);
  return books;
}

function checkoutDb(books) {
  let placed = null;
  const db = fakeDb([
    [/^BEGIN|^COMMIT|^ROLLBACK/, []],
    [/SELECT \* FROM books WHERE id = \$1 FOR UPDATE/, ([id]) => (books[id] ? [books[id]] : [])],
    [/UPDATE books SET stock/, []],
    [/INSERT INTO orders/, (params) => {
      placed = {
        id: 77,
        items: JSON.parse(params[1]),
        subtotal: params[2],
        shipping: params[3],
        total: params[4],
        address: JSON.parse(params[5]),
        status: params[6],
        created_at: new Date().toISOString(),
      };
      return [placed];
    }],
  ]);
  return { db, order: () => placed };
}

function post(body) {
  return { method: 'POST', body };
}

test('the price charged comes from the catalogue, not from the request', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    // The browser claims each book costs 1 rupee. It does not get to.
    const res = await call('/api/orders', post({
      items: [{ id: 1, quantity: 2, price: 1 }, { id: 2, quantity: 1, price: 1 }],
      address: ADDRESS,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.subtotal, 400 * 2 + 250);
    assert.equal(res.body.items.every((item) => item.price > 1), true);
  });
});

test('an order below the free-shipping threshold is charged for delivery', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    const res = await call('/api/orders', post({ items: [{ id: 2, quantity: 1 }], address: ADDRESS }));

    assert.equal(res.status, 201);
    assert.ok(res.body.subtotal < FREE_SHIPPING_OVER);
    assert.equal(res.body.shipping, SHIPPING_FEE);
    assert.equal(res.body.total, res.body.subtotal + SHIPPING_FEE);
  });
});

test('an order over the threshold ships free and totals to the subtotal', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    const res = await call('/api/orders', post({ items: [{ id: 1, quantity: 3 }], address: ADDRESS }));

    assert.equal(res.status, 201);
    assert.equal(res.body.shipping, 0);
    assert.equal(res.body.total, res.body.subtotal);
  });
});

test('running out of stock is a 409 that names the book, and nothing is deducted', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    // Only one copy of Dubliners exists.
    const res = await call('/api/orders', post({ items: [{ id: 2, quantity: 2 }], address: ADDRESS }));

    assert.equal(res.status, 409);
    assert.match(res.body.error, /Dubliners/);
    assert.equal(db.seen.some((q) => /UPDATE books SET stock/.test(q.sql)), false);
    assert.equal(db.seen.at(-1).sql, 'ROLLBACK');
  });
});

test('a partly available cart deducts nothing at all', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    // The first line is fine; the second is not. The whole checkout has to
    // roll back, or the shopper is charged for half an order.
    const res = await call('/api/orders', post({
      items: [{ id: 1, quantity: 1 }, { id: 2, quantity: 9 }],
      address: ADDRESS,
    }));

    assert.equal(res.status, 409);
    assert.equal(db.seen.some((q) => /^COMMIT/.test(q.sql)), false);
    assert.equal(db.seen.at(-1).sql, 'ROLLBACK');
  });
});

test('duplicate lines are merged and locked in id order', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    const res = await call('/api/orders', post({
      items: [{ id: 2, quantity: 1 }, { id: 1, quantity: 1 }, { id: 1, quantity: 1 }],
      address: ADDRESS,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.items.find((item) => item.id === 1).quantity, 2);

    // Every checkout takes its row locks in the same order, so two shoppers
    // buying the same two books cannot deadlock each other.
    const locked = db.seen
      .filter((q) => /FOR UPDATE/.test(q.sql))
      .map((q) => q.params[0]);
    assert.deepEqual(locked, [1, 2]);
  });
});

test('a cart with a nonsense quantity is refused before any lock is taken', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    const res = await call('/api/orders', post({ items: [{ id: 1, quantity: 0 }], address: ADDRESS }));

    assert.equal(res.status, 400);
    assert.equal(db.seen.length, 0);
  });
});

test('an order cannot be placed without an address', async () => {
  const { db } = checkoutDb(catalogue());
  await withRouter({ db, routerPath: '../server/routes/orders', mountAt: '/api/orders' }, async (call) => {
    const res = await call('/api/orders', post({ items: [{ id: 1, quantity: 1 }], address: { name: 'Ada' } }));

    assert.equal(res.status, 400);
    assert.equal(db.seen.length, 0);
  });
});
