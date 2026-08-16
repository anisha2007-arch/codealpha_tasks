const http = require('node:http');
const WebSocket = require('ws');

const { fakeDb, stubModule, unstub } = require('./helpers');

// Shared by the signalling test files: a real server on a real port, real
// WebSocket clients, and a scripted database. Not named *.test.js, so the
// runner does not try to run it on its own.

const ROOMS = { 'alpha-000000': 1, 'beta-000000': 2 };

function startServer() {
  const db = fakeDb([
    [/SELECT id FROM rooms WHERE slug/, ([slug]) => (ROOMS[slug] ? [{ id: ROOMS[slug] }] : [])],
    [/SELECT name FROM users WHERE id/, ([id]) => [{ name: `User ${id}` }]],
    [/INSERT INTO room_visits/, []],
  ]);

  const stubbed = [
    stubModule('../server/db', db),
    stubModule('../server/auth', {
      TOKEN_COOKIE: 'session',
      // Every socket in these tests is signed in; who as comes from the cookie.
      userIdFromToken: (token) => (token ? Number(token) : null),
    }),
  ];
  // Both, and in this order. signal-session.js captures db and auth at load
  // time, so a stale copy of it would keep answering with the *previous*
  // test's fake database — which the tests below inspect by identity.
  delete require.cache[require.resolve('../server/signal-session')];
  delete require.cache[require.resolve('../server/signalling')];
  const signalling = require('../server/signalling');

  const server = http.createServer((req, res) => res.end());
  const wss = signalling.attach(server);

  return {
    db,
    signalling,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      delete require.cache[require.resolve('../server/signal-session')];
      delete require.cache[require.resolve('../server/signalling')];
      unstub(stubbed);
    },
  };
}

// Opens a socket, waits for its welcome, and records everything after it.
function join(port, slug, userId) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/signal?room=${slug}`, {
    headers: { Cookie: `session=${userId}` },
  });
  socket.seen = [];
  socket.closed = null;
  socket.on('error', () => {});
  socket.on('close', (code, reason) => { socket.closed = { code, reason: String(reason) }; });
  socket.on('message', (raw) => socket.seen.push(JSON.parse(raw)));

  return new Promise((resolve) => {
    socket.on('open', () => resolve(socket));
    socket.on('close', () => resolve(socket));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function welcomeOf(socket) {
  return socket.seen.find((event) => event.type === 'welcome');
}

module.exports = { ROOMS, startServer, join, settle, welcomeOf };
