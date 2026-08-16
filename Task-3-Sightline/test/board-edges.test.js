const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const { fakeDb, stubModule, unstub, withRouter } = require('./helpers');

// The corners of a shared board: what the owner may do to their own project,
// what happens to a card assigned to somebody who has just been shown the door,
// what two people dropping into one column at the same moment get back, and
// whether a notification reaches both of a person's tabs.
//
// These run against the pattern-matching stand-in rather than a real SQLite
// database, because Sightline's schema is the one that cannot be translated
// honestly: it adds its unique constraint from a PL/pgSQL DO block and marks it
// DEFERRABLE, which is exactly the behaviour the reorder depends on and exactly
// what SQLite has no equivalent for.

// ---------------------------------------------------------------- ownership

test('the owner cannot be removed from their own project, so it always has one', async () => {
  const db = fakeDb([
    [/FROM project_members WHERE project_id/, [{ role: 'owner' }]],
    [/DELETE FROM project_members/, []],
  ]);

  await withRouter({ db, routerPath: '../server/routes/projects', mountAt: '/api/projects', userId: 1 },
    async (call) => {
      const self = await call('/api/projects/7/members/1', { method: 'DELETE' });
      assert.equal(self.status, 400);
      assert.match(self.body.error, /owner cannot be removed/i);

      // And nothing was deleted on the way to saying so.
      const deletes = db.seen.filter((q) => /DELETE FROM project_members/.test(q.sql));
      assert.deepEqual(deletes, [], 'the refusal happens before the query');
    });
});

test('removing an ordinary member is allowed, and never touches an owner row', async () => {
  const db = fakeDb([
    [/FROM project_members WHERE project_id/, [{ role: 'owner' }]],
    [/DELETE FROM project_members/, [{}]],
    [/UPDATE tasks SET assignee_id = NULL/, []],
    [/SELECT .* FROM project_members .* JOIN users/, []],
  ]);

  await withRouter({ db, routerPath: '../server/routes/projects', mountAt: '/api/projects', userId: 1 },
    async (call) => {
      const removed = await call('/api/projects/7/members/9', { method: 'DELETE' });
      assert.notEqual(removed.status, 500);

      const del = db.seen.find((q) => /DELETE FROM project_members/.test(q.sql));
      assert.ok(del, 'a member really is removed');
      assert.match(del.sql, /role <> 'owner'/, "and the query refuses to take the owner even if asked");
    });
});

// Their cards stay on the board; they just stop being theirs. Leaving the
// assignment behind would show a name that can no longer be reassigned to.
test('removing a member unassigns their cards rather than deleting them', async () => {
  const db = fakeDb([
    [/FROM project_members WHERE project_id/, [{ role: 'owner' }]],
    [/DELETE FROM project_members/, [{}]],
    [/UPDATE tasks SET assignee_id = NULL/, []],
    [/SELECT .* FROM project_members .* JOIN users/, []],
  ]);

  await withRouter({ db, routerPath: '../server/routes/projects', mountAt: '/api/projects', userId: 1 },
    async (call) => {
      await call('/api/projects/7/members/9', { method: 'DELETE' });

      const unassign = db.seen.find((q) => /UPDATE tasks SET assignee_id = NULL/.test(q.sql));
      assert.ok(unassign, 'their cards are unassigned');
      assert.deepEqual(unassign.params, [7, 9]);

      const deletedTasks = db.seen.filter((q) => /DELETE FROM tasks/.test(q.sql));
      assert.deepEqual(deletedTasks, [], 'and nothing of theirs is deleted');
    });
});

// -------------------------------------------------------------- assignment

// The board routers export two routers rather than one, so they are mounted by
// hand here the way server/index.js mounts them.
async function withBoard({ db, extraDb = {} }, run) {
  const stubbed = [
    stubModule('../server/db', { ...db, ...extraDb }),
    stubModule('../server/auth', {
      requireLogin: (req, res, next) => next(),
      readSession: (req, res, next) => next(),
      router: express.Router(),
    }),
    stubModule('../server/realtime', { broadcast() {}, afterResponse() {}, attach() {} }),
    stubModule('../server/notifications', { notify: async () => {}, nameOf: async () => 'Ann' }),
    stubModule('../server/queries/tasks', {
      fetchTask: async () => ({ id: 5, title: 'T', status: 'todo', assignee: null }),
      fetchBoard: async () => ({ columns: [] }),
    }),
  ];

  const modules = ['../server/members', '../server/routes/tasks', '../server/routes/task-order'];
  for (const m of modules) delete require.cache[require.resolve(m)];
  const { boardRouter } = require('../server/routes/tasks');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.userId = 1; next(); });
  app.use('/api/projects/:id/tasks', boardRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, method, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    return await run(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const m of modules) delete require.cache[require.resolve(m)];
    unstub(stubbed);
  }
}

test('a card cannot be assigned to somebody who is no longer on the project', async () => {
  // The membership query answers "no" for user 9: they were removed a moment
  // ago and the dialog in the browser has not caught up.
  const db = fakeDb([
    [/SELECT role FROM project_members/, ([, userId]) => (Number(userId) === 1 ? [{ role: 'owner' }] : [])],
  ]);

  await withBoard({ db }, async (call) => {
    const created = await call('/api/projects/7/tasks', 'POST', { title: 'Ship it', assigneeId: 9 });

    assert.equal(created.status, 400, 'a stale assignee is a bad request, not a 500');
    assert.match(created.body.error, /not on this project/i);

    const inserts = db.seen.filter((q) => /INSERT INTO tasks/.test(q.sql));
    assert.deepEqual(inserts, [], 'and no card is created holding a stranger');
  });
});

test('a card can still be assigned to somebody who is on the project', async () => {
  const db = fakeDb([
    [/SELECT role FROM project_members/, [{ role: 'member' }]],
    [/coalesce\(max\(position\)/, [{ pos: 1 }]],
    [/INSERT INTO tasks/, [{ id: 5 }]],
  ]);

  await withBoard({
    db,
    extraDb: {
      lockColumn: async () => {},
      transaction: async (fn) => fn({ query: db.query, release() {} }),
    },
  }, async (call) => {
    const created = await call('/api/projects/7/tasks', 'POST', { title: 'Ship it', assigneeId: 9 });
    assert.equal(created.status, 201, 'the control case still works');
  });
});

// ------------------------------------------------------------------ reorder

// Two people dropping a card into the same column at the same moment. One
// transaction commits; the other trips the unique constraint on
// (project_id, status, position). That is the board having moved underneath
// somebody, which is a 409 they can act on -- not a 500.
test('a reorder that collides is a 409 that tells you to reload', async () => {
  const db = fakeDb([
    [/SELECT role FROM project_members/, [{ role: 'owner' }]],
    [/pg_advisory_xact_lock/, []],
    [/SELECT id, status, position FROM tasks/, [{ id: 11, status: 'todo', position: 1 }]],
    [/UPDATE tasks SET status/, () => {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "tasks_column_position_key"'),
        { code: '23505' }
      );
    }],
  ]);

  await withBoard({
    db,
    extraDb: {
      lockColumn: (client, projectId, status) =>
        client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sightline:${projectId}:${status}`]),
      transaction: async (fn) => fn({ query: db.query, release() {} }),
    },
  }, async (call) => {
    const moved = await call('/api/projects/7/tasks/order', 'PUT', { status: 'todo', taskIds: [11] });

    assert.equal(moved.status, 409, 'a collision is a conflict, not a server error');
    assert.match(moved.body.error, /board moved/i);
    assert.match(moved.body.error, /reload/i, 'and says what to do about it');

    // The lock is what makes collisions rare in the first place.
    assert.ok(
      db.seen.some((q) => /pg_advisory_xact_lock/.test(q.sql)),
      'the column is locked before anything is renumbered'
    );
  });
});

// A deadlock is contention too, and the client already knows how to handle a
// 409. This used to fall through asConflict and become a 500 — so a pair of
// people dragging between different columns at the same moment got
// "Something went wrong." instead of the message written for exactly that.
//
// Row locks are ordered now (one FOR UPDATE, ORDER BY id, so two transactions
// cannot take the same pair in opposite orders) and 40P01 should no longer
// reach here. The translation is asserted anyway: a deadlock that does happen
// must not be a 500.
test('a deadlock is a 409, not a 500', async () => {
  const db = fakeDb([
    [/SELECT role FROM project_members/, [{ role: 'owner' }]],
    [/pg_advisory_xact_lock/, []],
    [/SELECT id, status, position FROM tasks/, [{ id: 11, status: 'todo', position: 1 }]],
    [/UPDATE tasks SET status/, () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    }],
  ]);

  await withBoard({
    db,
    extraDb: {
      lockColumn: async () => {},
      transaction: async (fn) => fn({ query: db.query, release() {} }),
    },
  }, async (call) => {
    const moved = await call('/api/projects/7/tasks/order', 'PUT', { status: 'todo', taskIds: [11] });

    assert.equal(moved.status, 409, 'a deadlock is contention, not a server error');
    assert.match(moved.body.error, /board moved/i);
    assert.match(moved.body.error, /reload/i);
  });
});

// The rows this transaction will touch are locked in one statement, in id
// order. Two statements would be enough to deadlock again on their own: a
// transaction can hold a row from the first while waiting on one in the
// second, and the cycle comes straight back.
test('a reorder locks every row it will touch in one id-ordered statement', async () => {
  const db = fakeDb([
    [/SELECT role FROM project_members/, [{ role: 'owner' }]],
    [/pg_advisory_xact_lock/, []],
    [/SELECT id, status, position FROM tasks/, [
      { id: 11, status: 'todo', position: 1 },
      { id: 12, status: 'todo', position: 2 },
    ]],
    [/UPDATE tasks SET status/, []],
    [/SELECT/, []],
  ]);

  await withBoard({
    db,
    extraDb: {
      lockColumn: async () => {},
      transaction: async (fn) => fn({ query: db.query, release() {} }),
    },
  }, async (call) => {
    await call('/api/projects/7/tasks/order', 'PUT', { status: 'todo', taskIds: [12, 11] });

    const locking = db.seen.filter((q) => /FOR UPDATE/.test(q.sql));
    assert.equal(locking.length, 1, 'one locking statement, not two');
    assert.match(locking[0].sql, /ORDER BY id\s+FOR UPDATE/, 'and it takes the rows in id order');
  });
});

// Any other database error is still a 500: asConflict must not swallow them.
test('a reorder that fails for any other reason is not disguised as a conflict', async () => {
  const db = fakeDb([
    [/SELECT role FROM project_members/, [{ role: 'owner' }]],
    [/pg_advisory_xact_lock/, []],
    [/SELECT id, status, position FROM tasks/, [{ id: 11, status: 'todo', position: 1 }]],
    [/UPDATE tasks SET status/, () => {
      throw Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' });
    }],
  ]);

  await withBoard({
    db,
    extraDb: {
      lockColumn: async () => {},
      transaction: async (fn) => fn({ query: db.query, release() {} }),
    },
  }, async (call) => {
    const moved = await call('/api/projects/7/tasks/order', 'PUT', { status: 'todo', taskIds: [11] });
    assert.equal(moved.status, 500);
    assert.match(moved.body.error, /connection terminated/i);
  });
});

// ------------------------------------------------------------ notifications

// A notification is addressed to a person, not to a board or a tab, so every
// window they have open has to get it. This drives real sockets, because the
// registry that makes it true is built in the upgrade handler.
test('a notification reaches every tab the same person has open', async () => {
  const db = fakeDb([[/FROM project_members WHERE project_id/, [{ role: 'member' }]]]);
  const stubbed = [
    stubModule('../server/db', db),
    stubModule('../server/auth', {
      TOKEN_COOKIE: 'session',
      userIdFromToken: (token) => (token ? Number(token) : null),
    }),
  ];
  delete require.cache[require.resolve('../server/members')];
  delete require.cache[require.resolve('../server/realtime')];
  const realtime = require('../server/realtime');

  const server = http.createServer((req, res) => res.end());
  const wss = realtime.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const open = (userId, projectId) => new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live?project=${projectId}`, {
      headers: { Cookie: `session=${userId}` },
    });
    socket.seen = [];
    socket.on('message', (raw) => socket.seen.push(JSON.parse(raw)));
    socket.on('error', () => {});
    socket.on('message', function first() {
      socket.off('message', first);
      resolve(socket);
    });
  });

  try {
    // Ann has the board open twice; Bee is on the same board once.
    const annTabOne = await open(1, 7);
    const annTabTwo = await open(1, 7);
    const bee = await open(2, 7);
    await new Promise((r) => setTimeout(r, 60));

    realtime.sendToUser(1, { type: 'notification.added', unread: 1 });
    await new Promise((r) => setTimeout(r, 80));

    const added = (socket) => socket.seen.filter((e) => e.type === 'notification.added');
    assert.equal(added(annTabOne).length, 1, 'the first tab is told');
    assert.equal(added(annTabTwo).length, 1, 'and so is the second');
    assert.equal(added(bee).length, 0, 'somebody else on the same board is not');

    // A tab that goes away stops being told, and does not take the other with it.
    annTabTwo.close();
    await new Promise((r) => setTimeout(r, 80));

    realtime.sendToUser(1, { type: 'notification.added', unread: 2 });
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(added(annTabOne).length, 2, 'the tab still open keeps receiving');
    assert.equal(added(annTabTwo).length, 1, 'the closed one received nothing more');

    for (const socket of [annTabOne, bee]) socket.close();
  } finally {
    wss.close();
    await new Promise((r) => server.close(r));
    delete require.cache[require.resolve('../server/realtime')];
    delete require.cache[require.resolve('../server/members')];
    unstub(stubbed);
  }
});
