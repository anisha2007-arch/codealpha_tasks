const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { POST_SELECT, toPost } = require('../queries/posts');
const { CIRCLE_SELECT, toCircle } = require('../queries/circles');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  const { rows } = await db.query(`${CIRCLE_SELECT} ORDER BY c.name`, [req.userId]);
  res.json(rows.map(toCircle));
});

router.get('/:slug', requireLogin, async (req, res) => {
  const { rows } = await db.query(`${CIRCLE_SELECT} WHERE c.slug = $2`, [
    req.userId, req.params.slug,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'No such circle.' });
  res.json(toCircle(rows[0]));
});

router.get('/:slug/posts', requireLogin, async (req, res) => {
  const { rows } = await db.query(
    `${POST_SELECT} WHERE c.slug = $2 ORDER BY p.created_at DESC LIMIT 100`,
    [req.userId, req.params.slug]
  );
  res.json(rows.map((r) => toPost(r, req.userId)));
});

router.post('/:slug/join', requireLogin, async (req, res) => {
  const found = await db.query('SELECT id FROM circles WHERE slug = $1', [req.params.slug]);
  if (!found.rows[0]) return res.status(404).json({ error: 'No such circle.' });

  const circleId = found.rows[0].id;
  const result = await db.toggleLink('memberships', ['circle_id', 'user_id'], [
    circleId, req.userId,
  ]);
  res.json({ joined: result.on, memberCount: result.count });
});

module.exports = router;
