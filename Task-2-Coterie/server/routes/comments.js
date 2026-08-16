const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { idParam, requireId } = require('../ids');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

// Comments are their own resource. They used to live inside routes/posts.js,
// which is why deleting one meant DELETE /api/posts/comments/:id — a comment
// id sitting where a post id belongs, under a path that says posts. Reading
// and writing are still scoped to a post; deleting is not.

const MAX_COMMENT = 400;

function toComment(row, viewerId) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { handle: row.handle, displayName: row.display_name },
    mine: row.author_id === viewerId,
  };
}

// Mounted at /api/posts/:id/comments. router.param does not fire for a
// parameter captured by the parent mount, so the id is checked here.
const postComments = express.Router({ mergeParams: true });
postComments.use(requireLogin, requireId('id', 'postId'));

postComments.get('/', async (req, res) => {
  const post = await db.query('SELECT 1 FROM posts WHERE id = $1', [req.postId]);
  if (!post.rowCount) return res.status(404).json({ error: 'That post is gone.' });

  const { rows } = await db.query(
    `SELECT m.id, m.body, m.created_at, m.author_id, u.handle, u.display_name
     FROM comments m JOIN users u ON u.id = m.author_id
     WHERE m.post_id = $1 ORDER BY m.created_at, m.id`,
    [req.postId]
  );
  res.json(rows.map((row) => toComment(row, req.userId)));
});

postComments.post('/', async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if (body.length > MAX_COMMENT) {
    return res.status(400).json({ error: `Comments are limited to ${MAX_COMMENT} characters.` });
  }
  if (hasControlChars(body, { allowBreaks: true })) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO comments (post_id, author_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at, author_id`,
      [req.postId, req.userId, body]
    );
    const me = await db.query('SELECT handle, display_name FROM users WHERE id = $1', [req.userId]);
    res.status(201).json(toComment({ ...rows[0], ...me.rows[0] }, req.userId));
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That post is gone.' });
    throw err;
  }
});

// Mounted at /api/comments.
const commentRouter = express.Router();
commentRouter.param('id', idParam);

commentRouter.delete('/:id', requireLogin, async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM comments WHERE id = $1 AND author_id = $2',
    [req.routeId, req.userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'That comment is not yours to delete.' });
  res.status(204).end();
});

module.exports = { postComments, commentRouter, MAX_COMMENT };
