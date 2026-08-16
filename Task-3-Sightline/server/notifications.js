const db = require('./db');
const realtime = require('./realtime');

// Writing a notification and pushing it live are one job, so they live in one
// place. The rows are written by the task routes when somebody is given a task
// and by the project routes when somebody is invited; the header badge reads
// them back through routes/notifications.js.

function toNotification(row) {
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    projectId: row.project_id,
    taskId: row.task_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

// Notification text names whoever caused it, and the routes only ever hold the
// actor's id, so the lookup lives here rather than in each of them.
async function nameOf(userId) {
  const { rows } = await db.query('SELECT name FROM users WHERE id = $1', [userId]);
  return rows[0] ? rows[0].name : 'Someone';
}

async function unreadCount(userId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return rows[0].unread;
}

async function list(userId, limit = 30) {
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map(toNotification);
}

// Nobody needs telling about something they did themselves, so an actor who is
// also the recipient writes no row. Notifying is a side effect of the thing
// that happened, never the point of the request: a failure here is logged and
// swallowed rather than turned into a failed assignment.
async function notify({ userId, actorId, projectId, taskId, kind, body }) {
  if (!userId || Number(userId) === Number(actorId)) return null;

  try {
    const { rows } = await db.query(
      `INSERT INTO notifications (user_id, actor_id, project_id, task_id, kind, body)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, actorId || null, projectId || null, taskId || null, kind, body]
    );

    const notification = toNotification(rows[0]);
    realtime.sendToUser(userId, {
      type: 'notification.added',
      notification,
      unread: await unreadCount(userId),
    });
    return notification;
  } catch (err) {
    console.error('Could not write a notification:', err.message);
    return null;
  }
}

// Reading is pushed as well as written, for the same reason arriving is: a
// person's alerts follow the person, not one tab. Without this, clearing them
// in one tab left every other tab showing a count for items that no longer
// exist. It self-heals — the badge re-reads the true count before it acts, and
// the next arrival pushes the right number — but "until something else
// happens" is not the same as now.
//
// Which rows changed is returned, not assumed: markRead takes a list of ids as
// well as "everything", so the other tabs are told what to cross off rather
// than crossing off all of it.
async function markRead(userId, ids) {
  const { rows } = Array.isArray(ids) && ids.length
    ? await db.query(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::int[]) RETURNING id`,
      [userId, ids]
    )
    : await db.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id',
      [userId]
    );

  const unread = await unreadCount(userId);

  // Nothing changed, so nobody's badge is stale and there is nothing to say.
  if (rows.length) {
    realtime.sendToUser(userId, {
      type: 'notification.read',
      ids: rows.map((row) => row.id),
      unread,
    });
  }

  return unread;
}

module.exports = { notify, list, unreadCount, markRead, toNotification, nameOf };
