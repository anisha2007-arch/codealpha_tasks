const express = require('express');
const { requireLogin } = require('../auth');
const { list, unreadCount, markRead } = require('../notifications');
const { positiveInt } = require('../members');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res) => {
  res.json({
    unread: await unreadCount(req.userId),
    items: await list(req.userId),
  });
});

// With no ids, everything unread is marked read — what the header does when
// the panel is opened.
router.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map(positiveInt).filter(Boolean).slice(0, 200)
    : null;
  res.json({ unread: await markRead(req.userId, ids) });
});

module.exports = router;
