const test = require('node:test');
const assert = require('node:assert/strict');

const { skip, withApp, marker } = require('./pg-harness');

// Dragging cards between columns, from two browsers, at the same moment.
//
// The reorder takes an advisory lock per column, so two reorders on *different*
// columns are not serialised by it — they are serialised, if at all, by the row
// locks they take next. Those used to be taken in two statements in whatever
// order the plan produced, which let a pair acquire the same rows in opposite
// orders: an ABBA deadlock that failed 20-40% of concurrent cross-column pairs
// with a 500, after both browsers hung for the second Postgres takes to notice.
//
// None of that exists to be got wrong in the SQLite-backed or pattern-matching
// suites, which is why it hid there. It needs a real database.

// Mounted the way server/index.js mounts them, including the export name for
// the module that ships two routers.
const MOUNTS = [
  ['/api/projects/:id/tasks', '../server/routes/tasks', 'boardRouter'],
  ['/api/projects', '../server/routes/projects'],
];

async function seed(db, tag, columns) {
  const user = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [`Dragger ${tag}`, `${tag}@example.test`]
  );
  const userId = user.rows[0].id;

  const project = await db.query(
    'INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id',
    [tag, userId]
  );
  const projectId = project.rows[0].id;

  await db.query(
    "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')",
    [projectId, userId]
  );

  const byColumn = {};
  for (const status of columns) {
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const task = await db.query(
        `INSERT INTO tasks (project_id, title, status, created_by, position)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [projectId, `${status} ${i}`, status, userId, i + 1]
      );
      ids.push(task.rows[0].id);
    }
    byColumn[status] = ids;
  }

  return { userId, projectId, byColumn };
}

async function cleanup(db, projectId, userId) {
  await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM project_members WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

// A deterministic shuffle, so a failure is reproducible.
function shuffled(ids, seed) {
  return ids
    .map((id, i) => ({ id, key: Math.sin(seed * 31 + i) }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.id);
}

test('concurrent reorders on different columns never deadlock', { skip }, async () => {
  const tag = marker('reorder');

  await withApp({ mounts: MOUNTS }, async ({ call, db, signInAs }) => {
    const { userId, projectId, byColumn } = await seed(db, tag, ['todo', 'doing']);
    signInAs(userId);

    try {
      const codes = {};
      const path = `/api/projects/${projectId}/tasks/order`;

      for (let round = 0; round < 20; round += 1) {
        // The lists overlap, which is what a card moving between columns looks
        // like: it is named by both requests at once.
        const moving = byColumn.doing[round % byColumn.doing.length];
        const alsoMoving = byColumn.todo[round % byColumn.todo.length];

        const todoList = shuffled([...byColumn.todo, moving], round);
        const doingList = shuffled(
          [...byColumn.doing.filter((id) => id !== moving), alsoMoving],
          round + 99
        );

        const both = await Promise.all([
          call(path, { method: 'PUT', body: { status: 'todo', taskIds: todoList } }),
          call(path, { method: 'PUT', body: { status: 'doing', taskIds: doingList } }),
        ]);
        for (const r of both) codes[r.status] = (codes[r.status] || 0) + 1;
      }

      assert.equal(codes[500], undefined,
        `a deadlock is never a 500, got ${JSON.stringify(codes)}`);
      assert.equal(codes[200], 40,
        `every reorder should succeed, got ${JSON.stringify(codes)}`);

      // What the whole thing is protecting: no two cards sharing a slot.
      const dupes = await db.query(
        `SELECT status, position, count(*) FROM tasks
         WHERE project_id = $1 GROUP BY status, position HAVING count(*) > 1`,
        [projectId]
      );
      assert.deepEqual(dupes.rows, [], 'no two cards share a slot in a column');
    } finally {
      await cleanup(db, projectId, userId);
    }
  });
});

test('a burst into one column stays contiguous', { skip }, async () => {
  const tag = marker('burst');

  await withApp({ mounts: MOUNTS }, async ({ call, db, signInAs }) => {
    const { userId, projectId, byColumn } = await seed(db, tag, ['todo']);
    signInAs(userId);

    try {
      const path = `/api/projects/${projectId}/tasks/order`;
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          call(path, { method: 'PUT', body: { status: 'todo', taskIds: shuffled(byColumn.todo, i) } })
        )
      );

      const codes = {};
      for (const r of results) codes[r.status] = (codes[r.status] || 0) + 1;
      assert.deepEqual(codes, { 200: 60 }, `every reorder should succeed, got ${JSON.stringify(codes)}`);

      const { rows } = await db.query(
        "SELECT position FROM tasks WHERE project_id = $1 AND status = 'todo' ORDER BY position",
        [projectId]
      );
      assert.deepEqual(
        rows.map((r) => r.position),
        Array.from({ length: byColumn.todo.length }, (_, i) => i + 1),
        'positions are contiguous from 1, with no gaps and no duplicates'
      );
    } finally {
      await cleanup(db, projectId, userId);
    }
  });
});
