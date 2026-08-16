// Who is on the other end of a signalling socket, and may they be here.
//
// Separate from signalling.js because it is the only part of that file that
// talks to the database and the only part that deals with what a browser
// happens to send in a header. What it returns is the small, checked fact the
// rest of the socket handling needs: which account, which room, what name.
const db = require('./db');
const { userIdFromToken, TOKEN_COOKIE } = require('./auth');

// The shape slugify() in routes/rooms.js produces. Anything else cannot name a
// real room, so it is turned away before it reaches a query: Postgres rejects
// some values outright, and a NUL byte in a parameter is one of them.
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

// A cookie value with a stray percent sign, such as "junk=100%", makes
// decodeURIComponent throw. The raw value is good enough to look a token up
// with, and a token that does not verify is turned away like any other.
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').filter(Boolean).map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return [name, decodeCookieValue(rest.join('='))];
    })
  );
}

// null when this socket has no business being here, for any reason. The caller
// does not get to know which, and neither does the browser.
async function authorise(req) {
  const cookies = parseCookies(req.headers.cookie);
  const userId = userIdFromToken(cookies[TOKEN_COOKIE]);
  const slug = new URL(req.url, 'http://localhost').searchParams.get('room');
  if (!userId || !SLUG_PATTERN.test(String(slug || ''))) return null;

  const room = await db.query('SELECT id FROM rooms WHERE slug = $1', [slug]);
  if (!room.rows[0]) return null;

  const user = await db.query('SELECT name FROM users WHERE id = $1', [userId]);
  if (!user.rows[0]) return null;

  return { userId, slug, roomId: room.rows[0].id, name: user.rows[0].name };
}

module.exports = { authorise, parseCookies, SLUG_PATTERN };
