const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { requireMember, requireOwner, positiveInt } = require('../members');
const realtime = require('../realtime');
const { notify, nameOf } = require('../notifications');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

const router = express.Router();

function toProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    memberCount: Number(row.member_count),
    openCount: Number(row.open_count),
    createdAt: row.created_at,
  };
}

const PROJECT_SELECT = `
  SELECT p.*, pm.role,
         (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_count
  FROM projects p
  JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
`;

router.use(requireLogin);

router.get('/', async (req, res) => {
  const { rows } = await db.query(`${PROJECT_SELECT} ORDER BY p.created_at DESC`, [req.userId]);
  res.json(rows.map(toProject));
});

router.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the project a name.' });
  // A description is a paragraph and may have line breaks; a name is one line.
  if (hasControlChars(name) || hasControlChars(description, { allowBreaks: true })) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  const project = await db.transaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO projects (name, description, owner_id) VALUES ($1,$2,$3) RETURNING *',
      [name, description, req.userId]
    );
    await client.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')",
      [rows[0].id, req.userId]
    );
    return rows[0];
  });

  res.status(201).json(toProject({ ...project, role: 'owner', member_count: 1, open_count: 0 }));
});

router.get('/:id', requireMember, async (req, res) => {
  const { rows } = await db.query(`${PROJECT_SELECT} WHERE p.id = $2`, [req.userId, req.projectId]);
  res.json(toProject(rows[0]));
});

router.patch('/:id', requireMember, requireOwner, async (req, res) => {
  const sets = [];
  const params = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Give the project a name.' });
    if (hasControlChars(name)) return res.status(400).json({ error: CONTROL_CHARS_ERROR });
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (req.body.description !== undefined) {
    const description = String(req.body.description).trim();
    if (hasControlChars(description, { allowBreaks: true })) {
      return res.status(400).json({ error: CONTROL_CHARS_ERROR });
    }
    params.push(description);
    sets.push(`description = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

  params.push(req.projectId);
  await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  const { rows } = await db.query(`${PROJECT_SELECT} WHERE p.id = $2`, [req.userId, req.projectId]);
  const project = toProject(rows[0]);

  res.json(project);
  realtime.afterResponse(res, () => {
    realtime.broadcast(req.projectId, { type: 'project.updated', project, actorId: req.clientId });
  });
});

router.delete('/:id', requireMember, requireOwner, async (req, res) => {
  await db.query('DELETE FROM projects WHERE id = $1', [req.projectId]);

  res.status(204).end();
  realtime.afterResponse(res, () => {
    realtime.broadcast(req.projectId, { type: 'project.removed', projectId: req.projectId, actorId: req.clientId });
  });
});

router.get('/:id/members', requireMember, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, pm.role
     FROM project_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1 ORDER BY pm.role, u.name`,
    [req.projectId]
  );
  res.json(rows);
});

// Inviting is the owner's, and so is removing. A member added by mistake could
// otherwise add more people and clear the board, which is what made the role
// column cosmetic.
router.post('/:id/members', requireMember, requireOwner, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (hasControlChars(email)) return res.status(400).json({ error: CONTROL_CHARS_ERROR });

  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows[0]) return res.status(404).json({ error: 'Nobody is registered with that email.' });

  const { rowCount } = await db.query(
    `INSERT INTO project_members (project_id, user_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [req.projectId, rows[0].id]
  );
  const member = { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: 'member' };

  res.status(201).json(member);

  realtime.afterResponse(res, async () => {
    // Everyone else with the board open needs the new person in their People
    // list and in their "Assigned to" dropdown straight away.
    realtime.broadcast(req.projectId, { type: 'member.added', member, actorId: req.clientId });
    if (!rowCount) return;

    const project = await db.query('SELECT name FROM projects WHERE id = $1', [req.projectId]);
    await notify({
      userId: member.id,
      actorId: req.userId,
      projectId: req.projectId,
      kind: 'project.invited',
      body: `${await nameOf(req.userId)} added you to "${project.rows[0].name}"`,
    });
  });
});

router.delete('/:id/members/:userId', requireMember, requireOwner, async (req, res) => {
  const userId = positiveInt(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Bad member id.' });
  if (userId === req.userId) {
    return res.status(400).json({ error: 'The owner cannot be removed from their own project.' });
  }

  const { rowCount } = await db.query(
    "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> 'owner'",
    [req.projectId, userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'They are not on this project.' });

  // Their cards stay on the board; they just stop being theirs. Leaving the
  // assignment behind would show a name that can no longer be reassigned to.
  await db.query(
    'UPDATE tasks SET assignee_id = NULL WHERE project_id = $1 AND assignee_id = $2',
    [req.projectId, userId]
  );

  res.status(204).end();
  realtime.afterResponse(res, () => {
    realtime.broadcast(req.projectId, { type: 'member.removed', memberId: userId, actorId: req.clientId });
    // Everyone else has been told; now the person who was removed loses the
    // socket. Without this their board keeps streaming — the membership check
    // only ever runs at the handshake — and they are the last to find out.
    realtime.removeFromProject(req.projectId, userId);
  });
});

module.exports = router;
