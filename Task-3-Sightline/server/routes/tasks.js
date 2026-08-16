const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { requireMember, loadTask, positiveInt, isMember } = require('../members');
const { fetchTask, fetchBoard } = require('../queries/tasks');
const { isStatus, DEFAULT_STATUS } = require('../statuses');
const realtime = require('../realtime');
const { afterResponse } = realtime;
const { notify, nameOf } = require('../notifications');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');
const { asConflict, clampPosition, nextPosition } = require('../positions');
const comments = require('./task-comments');
const order = require('./task-order');

// "Is this person on this project" is the same question the route guards ask,
// so it is the same query: isMember() in server/members.js, not a fourth copy
// of it here.
async function assigneeIdFor(projectId, value) {
  if (value === null || value === undefined || value === '') return null;

  const userId = positiveInt(value);
  if (userId && await isMember(projectId, userId)) return userId;

  throw Object.assign(new Error('That person is not on this project.'), { status: 400 });
}

// Writes the "somebody gave you this" row, once the assignee is somebody new
// and somebody other than the person doing the assigning.
async function noticeAssignment(req, task) {
  await notify({
    userId: task.assignee.id,
    actorId: req.userId,
    projectId: req.projectId,
    taskId: task.id,
    kind: 'task.assigned',
    body: `${await nameOf(req.userId)} assigned "${task.title}" to you`,
  });
}

const boardRouter = express.Router({ mergeParams: true });
boardRouter.use(requireLogin, requireMember);

boardRouter.get('/', async (req, res) => {
  res.json(await fetchBoard(req.projectId));
});

boardRouter.post('/', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const status = isStatus(req.body.status) ? req.body.status : DEFAULT_STATUS;
  if (!title) return res.status(400).json({ error: 'Give the task a title.' });
  // A body is a paragraph and may have line breaks; a title is one line.
  if (hasControlChars(title) || hasControlChars(body, { allowBreaks: true })) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  const assigneeId = await assigneeIdFor(req.projectId, req.body.assigneeId);

  const task = await db.transaction(async (client) => {
    await db.lockColumn(client, req.projectId, status);
    const position = await nextPosition(client, req.projectId, status);
    const created = await client.query(
      `INSERT INTO tasks (project_id, title, body, status, assignee_id, created_by, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.projectId, title, body, status, assigneeId, req.userId, position]
    );
    return fetchTask(created.rows[0].id, client);
  }).catch(asConflict);

  res.status(201).json(task);

  afterResponse(res, async () => {
    realtime.broadcast(req.projectId, { type: 'task.created', task, actorId: req.clientId });
    if (task.assignee) await noticeAssignment(req, task);
  });
});

// Dragging a card renumbers a whole column at once, which is a different
// shape of write from ordinary task CRUD and has its own transaction.
boardRouter.use('/order', order);

const taskRouter = express.Router();
taskRouter.use(requireLogin);

taskRouter.patch('/:taskId', loadTask, async (req, res) => {
  const before = await fetchTask(req.taskId);

  const updates = [];
  const params = [];

  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (!title) return res.status(400).json({ error: 'A task needs a title.' });
    if (hasControlChars(title)) return res.status(400).json({ error: CONTROL_CHARS_ERROR });
    params.push(title);
    updates.push(`title = $${params.length}`);
  }
  if (req.body.body !== undefined) {
    const body = String(req.body.body).trim();
    if (hasControlChars(body, { allowBreaks: true })) {
      return res.status(400).json({ error: CONTROL_CHARS_ERROR });
    }
    params.push(body);
    updates.push(`body = $${params.length}`);
  }
  if (req.body.status !== undefined && !isStatus(req.body.status)) {
    return res.status(400).json({ error: 'Unknown column.' });
  }
  if (req.body.position !== undefined && clampPosition(req.body.position) === null) {
    return res.status(400).json({ error: 'That is not a position.' });
  }
  if (req.body.assigneeId !== undefined) {
    params.push(await assigneeIdFor(req.projectId, req.body.assigneeId));
    updates.push(`assignee_id = $${params.length}`);
  }

  const status = req.body.status !== undefined ? req.body.status : before.status;
  const movingColumn = status !== before.status;
  if (!updates.length && !movingColumn && req.body.position === undefined) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  const task = await db.transaction(async (client) => {
    // A move into another column needs that column's lock, because it has to
    // pick a free slot in it. The dialog's Column dropdown sends a status and
    // no position; without this the task kept the position it had in its old
    // column and landed in the middle of the new one.
    if (movingColumn || req.body.position !== undefined) {
      await db.lockColumn(client, req.projectId, status);
    }

    const sets = [...updates];
    const values = [...params];

    if (movingColumn) {
      values.push(status);
      sets.push(`status = $${values.length}`);
    }

    const position = req.body.position !== undefined
      ? clampPosition(req.body.position)
      : (movingColumn ? await nextPosition(client, req.projectId, status) : null);

    if (position !== null) {
      values.push(position);
      sets.push(`position = $${values.length}`);
    }

    values.push(req.taskId);
    await client.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    return fetchTask(req.taskId, client);
  }).catch(asConflict);

  res.json(task);

  afterResponse(res, async () => {
    realtime.broadcast(req.projectId, { type: 'task.updated', task, actorId: req.clientId });
    const newAssignee = task.assignee && task.assignee.id;
    if (newAssignee && newAssignee !== (before.assignee && before.assignee.id)) {
      await noticeAssignment(req, task);
    }
  });
});

// The owner can clear anything off the board; everyone else can delete what
// they put there. Before this, req.projectRole was set and never read, so any
// member could delete any task and "owner" meant nothing.
taskRouter.delete('/:taskId', loadTask, async (req, res) => {
  if (req.projectRole !== 'owner' && req.taskCreatedBy !== req.userId) {
    return res.status(403).json({ error: 'Only the project owner or whoever created this task can delete it.' });
  }

  const task = await fetchTask(req.taskId);
  await db.query('DELETE FROM tasks WHERE id = $1', [req.taskId]);

  res.status(204).end();
  afterResponse(res, () => {
    realtime.broadcast(req.projectId, {
      type: 'task.removed',
      taskId: req.taskId,
      title: task ? task.title : '',
      actorId: req.clientId,
    });
  });
});

taskRouter.use('/:taskId/comments', loadTask, comments);

module.exports = { boardRouter, taskRouter };
