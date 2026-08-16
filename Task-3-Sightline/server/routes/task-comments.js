const express = require('express');
const db = require('../db');
const realtime = require('../realtime');
const { fetchTask } = require('../queries/tasks');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

// The discussion under a task, mounted by routes/tasks.js at
// /api/tasks/:taskId/comments behind loadTask, so req.taskId and req.projectId
// are already resolved and access is already checked.
const router = express.Router({ mergeParams: true });

function toComment(row, viewerId) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { id: row.author_id, name: row.author_name },
    mine: row.author_id === viewerId,
  };
}

router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.body, c.created_at, c.author_id, u.name AS author_name
     FROM task_comments c JOIN users u ON u.id = c.author_id
     WHERE c.task_id = $1 ORDER BY c.created_at, c.id`,
    [req.taskId]
  );
  res.json(rows.map((row) => toComment(row, req.userId)));
});

// Answers with the comment *and* the task it belongs to, because posting a
// comment changes the card: its comment count is part of the task. Returning
// only the comment is why a card read "2 comments" forever while the thread
// filled up underneath it.
router.post('/', async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if (hasControlChars(body, { allowBreaks: true })) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  const { rows } = await db.query(
    `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1,$2,$3)
     RETURNING id, body, created_at, author_id`,
    [req.taskId, req.userId, body]
  );
  const me = await db.query('SELECT name FROM users WHERE id = $1', [req.userId]);
  const comment = toComment({ ...rows[0], author_name: me.rows[0].name }, req.userId);
  const task = await fetchTask(req.taskId);

  res.status(201).json({ comment, task });

  realtime.afterResponse(res, () => {
    realtime.broadcast(req.projectId, {
      type: 'comment.added',
      taskId: req.taskId,
      comment: { ...comment, mine: false },
      actorId: req.clientId,
    });
    // The card on everyone's board carries the count, so the board itself has
    // to hear about this and not only whoever has the dialog open.
    realtime.broadcast(req.projectId, { type: 'task.updated', task, actorId: req.clientId, quiet: true });
  });
});

module.exports = router;
