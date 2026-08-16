const express = require('express');
const db = require('../db');
const { requireLogin, DISPLAY_NAME_MAX } = require('../auth');
const { POST_SELECT, toPost } = require('../queries/posts');
const { PROFILE_SELECT, toProfile } = require('../queries/profiles');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

const router = express.Router();

// Registration lowercases a handle and HANDLE_PATTERN keeps it that way, so
// every handle in the table is lowercase. A URL typed or shared with different
// casing is still the same person, and matching the column exactly rather than
// case-insensitively keeps the unique index doing the work.
router.param('handle', (req, res, next, value) => {
  req.handle = String(value == null ? '' : value).toLowerCase();
  next();
});

// Suggestions are people you do not already follow, busiest first.
router.get('/', requireLogin, async (req, res) => {
  const search = String(req.query.q || '').trim();
  // A NUL byte in a search term is refused by Postgres before it can match
  // anything, so it never reaches the query. Nobody's handle has one.
  if (hasControlChars(search)) {
    return res.status(400).json({ error: 'That is not something you can search for.' });
  }

  const params = [req.userId];
  let where = 'WHERE u.id <> $1';

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (u.handle ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`;
  }

  const { rows } = await db.query(
    `${PROFILE_SELECT} ${where} ORDER BY post_count DESC, u.handle LIMIT 24`,
    params
  );
  res.json(rows.map((r) => toProfile(r, req.userId)));
});

router.get('/:handle', requireLogin, async (req, res) => {
  const { rows } = await db.query(`${PROFILE_SELECT} WHERE u.handle = $2`, [
    req.userId, req.handle,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'No such person here.' });
  res.json(toProfile(rows[0], req.userId));
});

router.get('/:handle/posts', requireLogin, async (req, res) => {
  const { rows } = await db.query(
    `${POST_SELECT} WHERE u.handle = $2 ORDER BY p.created_at DESC LIMIT 100`,
    [req.userId, req.handle]
  );
  res.json(rows.map((r) => toPost(r, req.userId)));
});

router.put('/me', requireLogin, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const bio = String(req.body.bio || '').trim();

  if (!displayName) return res.status(400).json({ error: 'A display name is required.' });
  if (displayName.length > DISPLAY_NAME_MAX) {
    return res.status(400).json({
      error: `Display names are limited to ${DISPLAY_NAME_MAX} characters.`,
    });
  }
  if (bio.length > 300) return res.status(400).json({ error: 'Keep the bio under 300 characters.' });
  // A bio is a paragraph and may have line breaks; a display name is one line.
  if (hasControlChars(displayName) || hasControlChars(bio, { allowBreaks: true })) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }

  await db.query('UPDATE users SET display_name = $1, bio = $2 WHERE id = $3', [
    displayName, bio, req.userId,
  ]);
  // $1 is the viewer and $2 is the profile being read, as everywhere else.
  // They are the same person here, which is why passing one parameter used to
  // work — but only by coincidence, and it read as though the fragment took
  // the subject as $1.
  const { rows } = await db.query(`${PROFILE_SELECT} WHERE u.id = $2`, [req.userId, req.userId]);
  res.json(toProfile(rows[0], req.userId));
});

// The two sides of the follows table, browsable from the profile counts.
// `pick` is the column holding the people we want back, `match` the one that
// has to equal the profile being looked at.
function followList(pick, match) {
  return async (req, res) => {
    const target = await db.query('SELECT id FROM users WHERE handle = $1', [req.handle]);
    if (!target.rows[0]) return res.status(404).json({ error: 'No such person here.' });

    const { rows } = await db.query(
      `${PROFILE_SELECT}
       WHERE u.id IN (SELECT ${pick} FROM follows WHERE ${match} = $2)
       ORDER BY u.handle LIMIT 200`,
      [req.userId, target.rows[0].id]
    );
    res.json(rows.map((r) => toProfile(r, req.userId)));
  };
}

router.get('/:handle/followers', requireLogin, followList('follower_id', 'followee_id'));
router.get('/:handle/following', requireLogin, followList('followee_id', 'follower_id'));

router.post('/:handle/follow', requireLogin, async (req, res) => {
  const target = await db.query('SELECT id FROM users WHERE handle = $1', [req.handle]);
  if (!target.rows[0]) return res.status(404).json({ error: 'No such person here.' });

  const targetId = target.rows[0].id;
  if (targetId === req.userId) {
    return res.status(400).json({ error: 'You cannot follow yourself.' });
  }

  const result = await db.toggleLink('follows', ['followee_id', 'follower_id'], [
    targetId, req.userId,
  ]);
  res.json({ following: result.on, followerCount: result.count });
});

module.exports = router;
