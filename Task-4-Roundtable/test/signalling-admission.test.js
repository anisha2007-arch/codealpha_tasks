const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startServer, join, settle } = require('./signalling-harness');

// Who is allowed to open a socket at all. Every one of these is a way in that
// has to be shut: no session, a slug that is not slug-shaped, a room that does
// not exist, and a room that is already full.

test('a socket without a session is closed on upgrade', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/signal?room=alpha-000000`);
    socket.on('error', () => {});
    const [code] = await new Promise((resolve) => socket.on('close', (...args) => resolve(args)));
    assert.equal(code, 4001);
  } finally {
    await harness.close();
  }
});

test('a room slug that is not slug-shaped never reaches a query', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const socket = await join(port, 'NOT%20a%20slug', 1);
    await settle();

    assert.equal(socket.closed.code, 4001);
    assert.equal(harness.db.seen.length, 0);
  } finally {
    await harness.close();
  }
});

test('a room that does not exist is refused', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const socket = await join(port, 'no-such-room', 1);
    await settle();
    assert.equal(socket.closed.code, 4001);
  } finally {
    await harness.close();
  }
});

test('the room fills up and then turns people away', async () => {
  const harness = startServer();
  const port = await harness.listen();
  const sockets = [];
  try {
    for (let i = 0; i < harness.signalling.MAX_PEERS; i += 1) {
      sockets.push(await join(port, 'alpha-000000', i + 1));
    }
    await settle();

    const extra = await join(port, 'alpha-000000', 99);
    await settle();
    assert.equal(extra.closed.code, 4002);

    // And a slot freed by someone leaving is usable again, which is what the
    // heartbeat exists to guarantee for browsers that never say goodbye.
    sockets.pop().close();
    await settle();
    const replacement = await join(port, 'alpha-000000', 100);
    await settle();
    assert.equal(replacement.closed, null);
    sockets.push(replacement);
  } finally {
    sockets.forEach((socket) => socket.close());
    await harness.close();
  }
});
