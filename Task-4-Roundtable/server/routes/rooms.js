const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireLogin } = require('../auth');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('../text');

const router = express.Router();

// The slug *is* the capability: anyone signed in who has the link may join, by
// design, so the random part has to be wide enough that it cannot be found by
// asking. Three bytes was 24 bits, which an unthrottled lookup endpoint can
// walk through; ten bytes is 80.
const SLUG_ENTROPY_BYTES = 10;

function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${base || 'room'}-${crypto.randomBytes(SLUG_ENTROPY_BYTES).toString('hex')}`;
}

function toRoom(row) {
  return {
    slug: row.slug,
    name: row.name,
    mine: row.mine,
    createdAt: row.created_at,
    lastVisit: row.last_visit,
  };
}

router.use(requireLogin);

// Rooms you made, plus any you have joined before.
router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.slug, r.name, r.created_at,
            (r.owner_id = $1) AS mine,
            (SELECT max(joined_at) FROM room_visits v
             WHERE v.room_id = r.id AND v.user_id = $1) AS last_visit
     FROM rooms r
     WHERE r.owner_id = $1
        OR EXISTS (SELECT 1 FROM room_visits v WHERE v.room_id = r.id AND v.user_id = $1)
     ORDER BY coalesce((SELECT max(joined_at) FROM room_visits v
                        WHERE v.room_id = r.id AND v.user_id = $1), r.created_at) DESC`,
    [req.userId]
  );
  res.json(rows.map(toRoom));
});

router.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the room a name.' });
  // slugify() strips these out of the slug, but the name column stores the
  // text as typed.
  if (hasControlChars(name)) return res.status(400).json({ error: CONTROL_CHARS_ERROR });

  const { rows } = await db.query(
    'INSERT INTO rooms (slug, name, owner_id) VALUES ($1,$2,$3) RETURNING *',
    [slugify(name), name, req.userId]
  );
  res.status(201).json(toRoom({ ...rows[0], mine: true, last_visit: null }));
});

// The shape slugify() produces. Anything else cannot name a real room, so it
// is turned away before it reaches a query: Postgres rejects some values
// outright, and a NUL byte in a parameter is one of them.
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

router.get('/:slug', async (req, res) => {
  if (!SLUG_PATTERN.test(String(req.params.slug || ''))) {
    return res.status(404).json({ error: 'No room with that link.' });
  }

  const { rows } = await db.query(
    'SELECT *, (owner_id = $1) AS mine, NULL AS last_visit FROM rooms WHERE slug = $2',
    [req.userId, req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No room with that link.' });
  res.json(toRoom(rows[0]));
});

module.exports = router;
