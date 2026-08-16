const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, join, settle, welcomeOf } = require('./signalling-harness');

// What the server does with a socket once it is in: who it tells about the
// newcomer, what it passes on, and the one rule it has to enforce -- a relayed
// message cannot leave the room it was sent from.

test('a signal addressed to a peer in another room is not relayed', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const alice = await join(port, 'alpha-000000', 1);
    const bob = await join(port, 'alpha-000000', 2);
    const mallory = await join(port, 'beta-000000', 3);
    await settle();

    const alicePeerId = welcomeOf(alice).peerId;
    assert.ok(alicePeerId, 'Alice should have been welcomed');

    // Mallory is in another room and knows Alice's peer id. The server has to
    // look the target up in the sender's own room, so it finds nothing.
    mallory.send(JSON.stringify({ type: 'signal', to: alicePeerId, data: { description: 'offer' } }));
    // Bob is in Alice's room, so his identical message must arrive.
    bob.send(JSON.stringify({ type: 'signal', to: alicePeerId, data: { description: 'legitimate' } }));
    await settle();

    const relayed = alice.seen.filter((event) => event.type === 'signal');
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0].data.description, 'legitimate');
    assert.equal(relayed[0].from, welcomeOf(bob).peerId);

    [alice, bob, mallory].forEach((socket) => socket.close());
  } finally {
    await harness.close();
  }
});

test('a newcomer is told who is already there, and they are told about it', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const alice = await join(port, 'alpha-000000', 1);
    await settle();
    const bob = await join(port, 'alpha-000000', 2);
    await settle();

    // Only the newcomer offers, so only the newcomer gets a roster.
    assert.equal(welcomeOf(alice).peers.length, 0);
    assert.equal(welcomeOf(bob).peers.length, 1);
    assert.equal(welcomeOf(bob).peers[0].peerId, welcomeOf(alice).peerId);

    const joined = alice.seen.find((event) => event.type === 'peer-joined');
    assert.equal(joined.peerId, welcomeOf(bob).peerId);

    bob.close();
    await settle();
    assert.ok(alice.seen.some((event) => event.type === 'peer-left' && event.peerId === joined.peerId));

    alice.close();
  } finally {
    await harness.close();
  }
});

test('a repeat visit inside the window writes no second row', async () => {
  const harness = startServer();
  const port = await harness.listen();
  try {
    const first = await join(port, 'alpha-000000', 1);
    await settle();
    first.close();
    await settle();
    const second = await join(port, 'alpha-000000', 1);
    await settle();
    second.close();

    // Two connections, two INSERT statements — but the INSERT is a guarded
    // SELECT, so the second one writes nothing. The guard is what matters
    // here: without it, a flaky connection writes a row every fifteen seconds.
    const inserts = harness.db.seen.filter((q) => /INSERT INTO room_visits/.test(q.sql));
    assert.equal(inserts.length, 2);
    for (const insert of inserts) {
      assert.match(insert.sql, /WHERE NOT EXISTS/);
      assert.match(insert.sql, /joined_at > now\(\)/);
    }
  } finally {
    await harness.close();
  }
});
