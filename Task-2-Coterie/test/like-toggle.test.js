const test = require('node:test');
const assert = require('node:assert/strict');

const { fakeDb, withRouter, stubModule, unstub } = require('./helpers');

// A like is one button that can be clicked twice before the first request has
// come back, and the count next to it has to be right afterwards. These tests
// cover both halves: db.toggleLink, which does the work, and the route, which
// reports it.

// Stands in for the pg pool, holding the join table in memory. Enough to run
// the real toggleLink end to end without Postgres.
function fakePg(rows) {
  const statements = [];

  async function query(text, params = []) {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    statements.push(sql);

    if (/^BEGIN|^COMMIT|^ROLLBACK|pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };

    if (/^DELETE FROM likes/.test(sql)) {
      const before = rows.length;
      const kept = rows.filter((r) => !(r.post === params[0] && r.user === params[1]));
      rows.length = 0;
      rows.push(...kept);
      const removed = before - rows.length;
      return { rows: removed ? [{ ok: 1 }] : [], rowCount: removed };
    }

    if (/^INSERT INTO likes/.test(sql)) {
      const exists = rows.some((r) => r.post === params[0] && r.user === params[1]);
      if (!exists) rows.push({ post: params[0], user: params[1] });
      return { rows: [], rowCount: exists ? 0 : 1 };
    }

    if (/^SELECT count\(\*\) FROM likes/.test(sql)) {
      const count = rows.filter((r) => r.post === params[0]).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    throw new Error(`Unexpected statement: ${sql}`);
  }

  class Pool {
    query(text, params) { return query(text, params); }
    async connect() { return { query, release() {} }; }
  }

  return { Pool, statements };
}

function loadRealDb(rows) {
  const pg = fakePg(rows);
  const stubbed = [stubModule('pg', pg)];
  delete require.cache[require.resolve('../server/db')];
  const db = require('../server/db');
  return {
    db,
    statements: pg.statements,
    done() {
      delete require.cache[require.resolve('../server/db')];
      unstub(stubbed);
    },
  };
}

test('toggling twice returns the row, and the count, to where it started', async () => {
  const rows = [{ post: 1, user: 9 }, { post: 1, user: 10 }];
  const { db, done } = loadRealDb(rows);
  try {
    const on = await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);
    assert.deepEqual(on, { on: true, count: 3 });

    const off = await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);
    assert.deepEqual(off, { on: false, count: 2 });

    assert.equal(rows.length, 2);
  } finally {
    done();
  }
});

test('a repeated like does not add a second row or double the count', async () => {
  const rows = [];
  const { db, done } = loadRealDb(rows);
  try {
    await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);
    // Turning it on again means turning it off; what must never happen is two
    // rows for one person, or a count that drifts from the rows.
    await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);
    const again = await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);

    assert.deepEqual(again, { on: true, count: 1 });
    assert.equal(rows.length, 1);
  } finally {
    done();
  }
});

test('the toggle and its count are one locked transaction', async () => {
  const { db, statements, done } = loadRealDb([]);
  try {
    await db.toggleLink('likes', ['post_id', 'user_id'], [1, 2]);

    // The count must be taken inside the same transaction as the write, or it
    // can report a total another request has already changed.
    assert.equal(statements[0], 'BEGIN');
    assert.match(statements[1], /pg_advisory_xact_lock/);
    assert.match(statements.at(-2), /^SELECT count\(\*\) FROM likes/);
    assert.equal(statements.at(-1), 'COMMIT');
  } finally {
    done();
  }
});

test('a table with no lock namespace is refused rather than left unlocked', async () => {
  const { db, done } = loadRealDb([]);
  try {
    await assert.rejects(
      () => db.toggleLink('sessions', ['a', 'b'], [1, 2]),
      /No lock namespace/
    );
  } finally {
    done();
  }
});

test('the route reports the state and the count it was given', async () => {
  const db = fakeDb([]);
  let liked = false;
  let count = 4;
  db.toggleLink = async () => {
    liked = !liked;
    count += liked ? 1 : -1;
    return { on: liked, count };
  };

  await withRouter({ db, routerPath: '../server/routes/posts', mountAt: '/api/posts' }, async (call) => {
    const first = await call('/api/posts/1/like', { method: 'POST', body: {} });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { liked: true, likeCount: 5 });

    const second = await call('/api/posts/1/like', { method: 'POST', body: {} });
    assert.deepEqual(second.body, { liked: false, likeCount: 4 });
  });
});

test('liking a post that has been deleted is a 404, not a 500', async () => {
  const db = fakeDb([]);
  db.toggleLink = async () => {
    throw Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
  };

  await withRouter({ db, routerPath: '../server/routes/posts', mountAt: '/api/posts' }, async (call) => {
    const res = await call('/api/posts/1/like', { method: 'POST', body: {} });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /gone/);
  });
});

test('a post id that is not a number never reaches the database', async () => {
  const db = fakeDb([]);
  db.toggleLink = async () => { throw new Error('should not have been called'); };

  await withRouter({ db, routerPath: '../server/routes/posts', mountAt: '/api/posts' }, async (call) => {
    const res = await call('/api/posts/abc/like', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    assert.equal(db.seen.length, 0);
  });
});
