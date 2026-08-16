const express = require('express');
const db = require('../db');
const { positiveInt } = require('../members');
const { fetchBoard } = require('../queries/tasks');
const { isStatus } = require('../statuses');
const { asConflict } = require('../positions');
const realtime = require('../realtime');
const { afterResponse } = realtime;

// Dragging a card, which is the only thing on the board that renumbers a whole
// column at once. Mounted by routes/tasks.js at /api/projects/:id/tasks/order,
// behind the same requireMember guard, so req.projectId is already resolved.
const router = express.Router({ mergeParams: true });

// A column with more cards than this in one request is not a board being
// dragged, so the work is bounded before the lock is taken.
const MAX_COLUMN_SIZE = 1000;

// Renumbers one column from an ordered list of task ids, in one transaction,
// under the column's advisory lock. This is the only way a position is ever
// set from the client: the client says what the order is, the server decides
// what the numbers are, so two people dropping cards at the same moment cannot
// both write the same position from stale snapshots.
router.put('/', async (req, res) => {
  const status = req.body.status;
  if (!isStatus(status)) return res.status(400).json({ error: 'Unknown column.' });

  const raw = Array.isArray(req.body.taskIds) ? req.body.taskIds : null;
  if (!raw || raw.length > MAX_COLUMN_SIZE) {
    return res.status(400).json({ error: 'Send the column order as a list of task ids.' });
  }

  const wanted = [...new Set(raw.map(positiveInt).filter(Boolean))];

  const tasks = await db.transaction(async (client) => {
    await db.lockColumn(client, req.projectId, status);

    // Every row this transaction will touch, locked in one statement in id
    // order.
    //
    // This used to be two statements — the named ids, then the rest of the
    // column — each locking in whatever order its plan produced. Two people
    // dragging between different columns take different advisory locks, so
    // nothing serialises them, and the pair could then grab the same two rows
    // in opposite orders. That is a plain ABBA deadlock, and it failed 20-40%
    // of concurrent cross-column pairs: both browsers froze for the second
    // Postgres takes to notice, then one card snapped back.
    //
    // Ordering each statement separately would not have been enough. Two
    // batches means a transaction can hold a row from the first while waiting
    // on a row in the second, and the cycle comes straight back. One
    // statement, one order, for every row involved.
    const { rows: locked } = await client.query(
      `SELECT id, status, position FROM tasks
       WHERE project_id = $1 AND (id = ANY($2::int[]) OR status = $3)
       ORDER BY id
       FOR UPDATE`,
      [req.projectId, wanted.length ? wanted : [0], status]
    );

    // Only ids that are really on this board move. Anything else is dropped
    // rather than trusted, so a crafted list cannot pull in another project's
    // tasks.
    const known = new Set(locked.map((row) => row.id));
    const ordered = wanted.filter((id) => known.has(id));
    const named = new Set(ordered);

    // Cards already in this column that the client did not mention — because
    // somebody else added them a moment ago — keep their order, below the ones
    // it did mention, rather than being renumbered into a collision. The sort
    // is here rather than in the query because the query has to come back in
    // id order; this is the same "ORDER BY position, id" it used to do.
    const rest = locked
      .filter((row) => row.status === status && !named.has(row.id))
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((row) => row.id);

    const final = [...ordered, ...rest];
    for (let index = 0; index < final.length; index += 1) {
      await client.query(
        'UPDATE tasks SET status = $1, position = $2 WHERE id = $3 AND project_id = $4',
        [status, index + 1, final[index], req.projectId]
      );
    }

    return fetchBoard(req.projectId, client);
  }).catch(asConflict);

  res.json(tasks);
  afterResponse(res, () => {
    realtime.broadcast(req.projectId, { type: 'tasks.reordered', tasks, actorId: req.clientId });
  });
});

module.exports = router;
