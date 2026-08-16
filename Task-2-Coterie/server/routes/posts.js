const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { idParam } = require('../ids');
const { POST_SELECT, toPost } = require('../queries/posts');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

const router = express.Router();
const MAX_BODY = 800;

// Every `:id` in this router is a database id, checked once here so all the
// routes below can read the parsed value off req.routeId.
router.param('id', idParam);

// The home feed is your own posts, everyone you follow, and every circle you
// have joined. "explore" widens it to every post on the server.
router.get('/', requireLogin, async (req, res) => {
  const explore = req.query.scope === 'explore';
  const where = explore
    ? ''
    : `WHERE p.author_id = $1
        OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
        OR p.circle_id IN (SELECT circle_id FROM memberships WHERE user_id = $1)`;

  const { rows } = await db.query(
    `${POST_SELECT} ${where} ORDER BY p.created_at DESC LIMIT 100`,
    [req.userId]
  );
  res.json(rows.map((r) => toPost(r, req.userId)));
});

router.post('/', requireLogin, async (req, res) => {
  const body = String(req.body.body || '').trim();
  const circleSlug = String(req.body.circle || '').trim();

  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if (body.length > MAX_BODY) {
    return res.status(400).json({ error: `Posts are limited to ${MAX_BODY} characters.` });
  }
  // A post may have line breaks in it; a circle slug is looked up as typed.
  if (hasControlChars(body, { allowBreaks: true }) || hasControlChars(circleSlug)) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  let circleId = null;
  if (circleSlug) {
    const { rows } = await db.query('SELECT id FROM circles WHERE slug = $1', [circleSlug]);
    if (!rows[0]) return res.status(400).json({ error: 'That circle does not exist.' });
    circleId = rows[0].id;
  }

  const created = await db.query(
    'INSERT INTO posts (author_id, circle_id, body) VALUES ($1,$2,$3) RETURNING id',
    [req.userId, circleId, body]
  );
  const { rows } = await db.query(`${POST_SELECT} WHERE p.id = $2`, [req.userId, created.rows[0].id]);
  res.status(201).json(toPost(rows[0], req.userId));
});

router.delete('/:id', requireLogin, async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM posts WHERE id = $1 AND author_id = $2',
    [req.routeId, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'That post is not yours to delete.' });
  res.status(204).end();
});

router.post('/:id/like', requireLogin, async (req, res) => {
  let result;
  try {
    result = await db.toggleLink('likes', ['post_id', 'user_id'], [req.routeId, req.userId]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That post is gone.' });
    throw err;
  }
  res.json({ liked: result.on, likeCount: result.count });
});

module.exports = router;
