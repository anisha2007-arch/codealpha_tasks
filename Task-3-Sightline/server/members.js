const db = require('./db');

// Everything about who is on a project lives here: the one membership query,
// the guards the routes hang off it, and the task-to-project resolution that
// the task routes need. The WebSocket handshake asks the same isMember() as
// the HTTP routes do, so there is one answer to "may this person see this
// board" rather than three copies of the query that can drift apart.

// Every id in this schema is a Postgres `integer`, which is 32 bits wide, so
// anything above this is not an id that could exist. Without the upper bound
// 1e30 passed Number.isInteger(), reached the query, and came back as
// "invalid input syntax for type integer" — a 500 for what is a bad request.
const MAX_ID = 2147483647;

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= MAX_ID ? number : null;
}

// Returns the person's role on the project, or null if they are not on it.
async function isMember(projectId, userId) {
  const project = positiveInt(projectId);
  const user = positiveInt(userId);
  if (!project || !user) return null;

  const { rows } = await db.query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [project, user]
  );
  return rows[0] ? rows[0].role : null;
}

// Guards every project-scoped route. Membership is checked against the
// database on each request rather than trusted from the client.
async function requireMember(req, res, next) {
  const projectId = positiveInt(req.params.id ?? req.params.projectId);
  if (!projectId) return res.status(400).json({ error: 'Bad project id.' });

  const role = await isMember(projectId, req.userId);
  if (!role) return res.status(404).json({ error: 'No such project.' });

  req.projectId = projectId;
  req.projectRole = role;
  next();
}

// Chained after requireMember. Inviting, removing people, renaming and
// deleting are the owner's alone: a member who was added by mistake should not
// be able to add more people or take the project apart.
function requireOwner(req, res, next) {
  if (req.projectRole !== 'owner') {
    return res.status(403).json({ error: 'Only the project owner can do that.' });
  }
  next();
}

// Resolves a task id to its project and checks membership on that project.
// A non-numeric id is a bad request, not a 500 from Postgres refusing to cast
// 'abc' to an integer.
async function loadTask(req, res, next) {
  const taskId = positiveInt(req.params.taskId);
  if (!taskId) return res.status(400).json({ error: 'Bad task id.' });

  const { rows } = await db.query('SELECT project_id, created_by FROM tasks WHERE id = $1', [taskId]);
  if (!rows[0]) return res.status(404).json({ error: 'No such task.' });

  const role = await isMember(rows[0].project_id, req.userId);
  if (!role) return res.status(404).json({ error: 'No such task.' });

  req.taskId = taskId;
  req.projectId = rows[0].project_id;
  req.projectRole = role;
  req.taskCreatedBy = rows[0].created_by;
  next();
}

module.exports = { isMember, requireMember, requireOwner, loadTask, positiveInt };
