const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');
const { hasControlChars, CONTROL_CHARS_ERROR } = require('./text');

const TOKEN_COOKIE = 'session';
// One wording for every way a sign-in can fail, so the reply never says which
// half was wrong.
const WRONG_LOGIN = 'Wrong email or password.';
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
// Deliberately loose: one @, something either side, and a dotted domain. Enough
// to reject "not-an-email" at the door without turning away real addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function isValidEmail(email) {
  return email.length <= EMAIL_MAX && EMAIL_PATTERN.test(email);
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: TOKEN_MAX_AGE,
    path: '/',
  };
}

// The one token check. Kept apart from the middleware so anything else that
// has a raw token — the WebSocket upgrade in the sibling projects — verifies
// it exactly the same way.
function userIdFromToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret).sub;
  } catch {
    return null;
  }
}

// Populates req.userId when a valid session cookie is present, otherwise
// leaves it undefined so public routes still work. Nothing here awaits, so it
// is a plain function.
function readSession(req, res, next) {
  const userId = userIdFromToken(req.cookies[TOKEN_COOKIE]);
  if (userId) req.userId = userId;
  else if (req.cookies[TOKEN_COOKIE]) res.clearCookie(TOKEN_COOKIE, cookieOptions());
  next();
}

function startSession(res, userId) {
  const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '7d' });
  res.cookie(TOKEN_COOKIE, token, cookieOptions());
}

function requireLogin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Please log in.' });
  next();
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || name.length > NAME_MAX || !email || password.length < 8) {
    return res.status(400).json({
      error: `A name of up to ${NAME_MAX} characters, an email, and a password of 8+ characters are required.`,
    });
  }
  if (hasControlChars(name) || hasControlChars(email)) {
    return res.status(400).json({ error: CONTROL_CHARS_ERROR });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await db.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING *',
      [name, email, hash]
    );
    startSession(res, rows[0].id);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already registered.' });
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  // A control character cannot be in anybody's stored email, and a NUL byte
  // would be refused by Postgres rather than simply not matching, so this is
  // the same answer as any other address that is not registered.
  if (hasControlChars(email)) return res.status(401).json({ error: WRONG_LOGIN });

  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: WRONG_LOGIN });
  }

  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(TOKEN_COOKIE, cookieOptions());
  res.status(204).end();
});

router.get('/me', requireLogin, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: 'Please log in.' });
  res.json({ user: publicUser(rows[0]) });
});

module.exports = { router, readSession, requireLogin, userIdFromToken, TOKEN_COOKIE };
