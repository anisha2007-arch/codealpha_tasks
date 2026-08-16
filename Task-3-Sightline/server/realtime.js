const { WebSocketServer } = require('ws');
const { isMember } = require('./members');
const { userIdFromToken, TOKEN_COOKIE } = require('./auth');

// projectId -> Set of sockets currently watching that board.
const rooms = new Map();
// userId -> Set of that person's sockets, for notifications, which follow the
// person rather than the board they happen to have open.
const byUser = new Map();

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

function addTo(map, key, socket) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
}

function join(projectId, userId, socket) {
  addTo(rooms, projectId, socket);
  addTo(byUser, userId, socket);
}

function leave(socket) {
  for (const map of [rooms, byUser]) {
    for (const [key, sockets] of map) {
      sockets.delete(socket);
      if (!sockets.size) map.delete(key);
    }
  }
}

function deliver(sockets, event) {
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

// Sends an event to every socket on a board, including the ones belonging to
// whoever caused it: a person with the board open in two tabs needs both to
// update. Events carry an actorId — the id of the browser tab that made the
// request, not the person — so only the one tab that already knows the outcome
// from its own HTTP response skips the echo. Every other tab, that person's
// second one included, applies it.
function broadcast(projectId, event) {
  deliver(rooms.get(Number(projectId)), event);
}

// Notifications are addressed to a person, on whatever board they have open.
function sendToUser(userId, event) {
  deliver(byUser.get(Number(userId)), event);
}

// Why a socket was closed, where the client can tell them apart.
// 4001 is the handshake saying no; 4003 is access being taken away from a
// socket that was already authorised.
const CLOSE_NOT_ALLOWED = 4001;
const CLOSE_REMOVED = 4003;

// Somebody has been removed from a project while they had it open.
//
// Membership is checked once, at the handshake, which is the right place for
// it — but it means nothing revokes a socket that was authorised before the
// removal. Their HTTP requests start returning 404 immediately, and their
// board carries on receiving every task title and description the team writes,
// indefinitely, until they happen to reload. Reloading is denied correctly,
// which is exactly what makes the leak invisible to whoever removed them.
//
// Their sockets on other boards are none of this function's business.
function removeFromProject(projectId, userId) {
  const sockets = rooms.get(Number(projectId));
  if (!sockets) return 0;

  let closed = 0;
  // A copy: closing a socket takes it out of this set.
  for (const socket of [...sockets]) {
    if (socket.userId !== Number(userId)) continue;
    socket.close(CLOSE_REMOVED, 'You were removed from this project.');
    closed += 1;
  }
  return closed;
}

// Runs fn once the response has actually gone out. Broadcasting before
// responding meant the echo usually beat the reply back to the tab that caused
// it, which is how a freshly created task announced itself as "was updated"
// and a fresh comment was rendered twice.
function afterResponse(res, fn) {
  res.on('finish', () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error('Post-response work failed:', err.message));
  });
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/live' });

  // This listener is async, so anything that rejects inside it becomes an
  // unhandled rejection and takes the whole process down, HTTP included. One
  // bad request must cost no more than its own connection.
  wss.on('connection', async (socket, req) => {
    // Registered before the first await. A client that gives up while the
    // membership query is still running fires 'close' before join() runs, and
    // a listener attached afterwards would never hear it: the socket would be
    // added to the room in readyState 3 and stay there for the life of the
    // process.
    socket.on('close', () => leave(socket));
    socket.on('error', () => leave(socket));

    try {
      const cookies = parseCookies(req.headers.cookie);
      const userId = userIdFromToken(cookies[TOKEN_COOKIE]);
      const projectId = Number(new URL(req.url, 'http://localhost').searchParams.get('project'));

      if (!userId || !projectId || !(await isMember(projectId, userId))) {
        socket.close(CLOSE_NOT_ALLOWED, 'Not allowed on this board.');
        return;
      }

      // The close listener above may already have fired while we were asking
      // the database. Joining now would put a dead socket into the room.
      if (socket.readyState !== socket.OPEN) return;

      socket.userId = userId;
      join(projectId, userId, socket);
      socket.send(JSON.stringify({ type: 'ready', projectId }));
    } catch (err) {
      console.error('Live connection failed:', err);
      leave(socket);
      socket.close(1011, 'Something went wrong.');
    }
  });

  return wss;
}

module.exports = {
  attach, broadcast, sendToUser, afterResponse, removeFromProject,
  CLOSE_NOT_ALLOWED, CLOSE_REMOVED,
};
