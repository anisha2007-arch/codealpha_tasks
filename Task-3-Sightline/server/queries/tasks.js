const db = require('../db');

// The shape of a task as every route and every broadcast reports it. Kept
// apart from the routes so the board route, the patch route, the reorder route
// and the comment route all answer with the same object.

const TASK_SELECT = `
  SELECT t.id, t.project_id, t.title, t.body, t.status, t.position, t.created_at,
         t.created_by, t.assignee_id, u.name AS assignee_name,
         (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
`;

function toTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    createdBy: row.created_by,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    commentCount: Number(row.comment_count),
  };
}

async function fetchTask(id, client = db) {
  const { rows } = await client.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  return rows[0] ? toTask(rows[0]) : null;
}

async function fetchBoard(projectId, client = db) {
  const { rows } = await client.query(
    `${TASK_SELECT} WHERE t.project_id = $1 ORDER BY t.status, t.position, t.id`,
    [projectId]
  );
  return rows.map(toTask);
}

async function fetchColumn(projectId, status, client = db) {
  const { rows } = await client.query(
    `${TASK_SELECT} WHERE t.project_id = $1 AND t.status = $2 ORDER BY t.position, t.id`,
    [projectId, status]
  );
  return rows.map(toTask);
}

module.exports = { TASK_SELECT, toTask, fetchTask, fetchBoard, fetchColumn };
