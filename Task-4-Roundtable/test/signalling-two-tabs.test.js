const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, join, settle, welcomeOf } = require('./signalling-harness');

// One person, two windows. A peer id names a connection, not a human, so the
// two tabs are two peers that happen to belong to the same account — and the
// call has to treat them as such, or somebody who opens a second tab either
// disappears from the room or takes their first tab down with them.

test('the same person in two tabs is two peers, not one', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    const tabOne = await join(port, 'alpha-000000', 1);
    const tabTwo = await join(port, 'alpha-000000', 1);
    await settle();

    const first = welcomeOf(tabOne);
    const second = welcomeOf(tabTwo);

    assert.ok(first && second, 'both tabs are welcomed');
    assert.notEqual(first.peerId, second.peerId, 'each connection gets its own peer id');
    assert.equal(first.name, second.name, 'and they are the same person');

    // The second tab is told the first is already there, so a call is offered
    // between them like any other pair.
    assert.deepEqual(
      second.peers.map((p) => p.peerId),
      [first.peerId],
      'the newcomer sees the tab that was already in the room'
    );

    // And the first tab is told about the second arriving.
    const joined = tabOne.seen.filter((e) => e.type === 'peer-joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].peerId, second.peerId);

    tabOne.close();
    tabTwo.close();
  } finally {
    await server.close();
  }
});

test('closing one tab leaves the other in the room', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    const tabOne = await join(port, 'alpha-000000', 1);
    const tabTwo = await join(port, 'alpha-000000', 1);
    const other = await join(port, 'alpha-000000', 2);
    await settle();

    const secondId = welcomeOf(tabTwo).peerId;
    tabTwo.close();
    await settle();

    // Everyone still in the room hears about the one that went.
    for (const [label, socket] of [['the other tab', tabOne], ['the other person', other]]) {
      const left = socket.seen.filter((e) => e.type === 'peer-left');
      assert.equal(left.length, 1, `${label} is told once`);
      assert.equal(left[0].peerId, secondId, `${label} is told which peer went`);
    }

    assert.equal(tabOne.readyState, tabOne.OPEN, 'and the remaining tab is untouched');

    // The room is not empty, so a third arrival still sees the two that remain.
    const late = await join(port, 'alpha-000000', 3);
    await settle();
    assert.equal(welcomeOf(late).peers.length, 2, 'the surviving tab is still on the roster');

    tabOne.close();
    other.close();
    late.close();
  } finally {
    await server.close();
  }
});

// A tab of your own is a real peer with real audio coming back, so the page
// has to mute it and label it. Only the server can say which peer that is, and
// it says so per recipient: "self" for one listener is an ordinary peer for
// everyone else, and nobody is sent anybody's user id to work it out.
test('your own other tab is marked as yours, and only to you', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    const tabOne = await join(port, 'alpha-000000', 1);
    const other = await join(port, 'alpha-000000', 2);
    const tabTwo = await join(port, 'alpha-000000', 1);
    await settle();

    const oneId = welcomeOf(tabOne).peerId;
    const twoId = welcomeOf(tabTwo).peerId;
    const otherId = welcomeOf(other).peerId;

    // What the second tab is told about the room it walked into.
    const asSeenByTabTwo = welcomeOf(tabTwo).peers;
    assert.equal(asSeenByTabTwo.find((p) => p.peerId === oneId).self, true, 'the first tab is me');
    assert.equal(asSeenByTabTwo.find((p) => p.peerId === otherId).self, false, 'the other person is not');

    // And what everyone already in the room is told about it arriving.
    const toTabOne = tabOne.seen.find((e) => e.type === 'peer-joined' && e.peerId === twoId);
    const toOther = other.seen.find((e) => e.type === 'peer-joined' && e.peerId === twoId);
    assert.equal(toTabOne.self, true, 'my first tab hears that the newcomer is me');
    assert.equal(toOther.self, false, 'the other person hears an ordinary newcomer');

    // The mechanism must not leak who anybody is.
    const everything = JSON.stringify([tabOne.seen, tabTwo.seen, other.seen]);
    assert.equal(/userId/.test(everything), false, 'no user id goes over the wire');

    tabOne.close();
    tabTwo.close();
    other.close();
  } finally {
    await server.close();
  }
});

// The room cap counts sockets, so without a per-user cap one account with six
// tabs fills a six-person room and everybody else is told it is full.
test('one account cannot take the whole room', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    const mine = [];
    for (let i = 0; i < 3; i += 1) mine.push(await join(port, 'alpha-000000', 1));
    await settle();
    assert.equal(mine.filter((s) => welcomeOf(s)).length, 3, 'three tabs of one account are fine');

    const fourth = await join(port, 'alpha-000000', 1);
    await settle();
    assert.equal(welcomeOf(fourth), undefined, 'the fourth is turned away');
    assert.equal(fourth.closed.code, 4003, 'with a code of its own, not "room full"');
    assert.match(fourth.closed.reason, /tabs/i, 'and a reason that says what happened');

    // The room is not full: it still has room for other people, which is the
    // whole point.
    const somebodyElse = await join(port, 'alpha-000000', 2);
    await settle();
    assert.ok(welcomeOf(somebodyElse), 'somebody else can still get in');

    for (const socket of [...mine, somebodyElse]) socket.close();
  } finally {
    await server.close();
  }
});

// Two tabs count as two seats, because each holds its own set of peer
// connections and its own share of the mesh.
test('a second tab takes a place in the room, and the cap still holds', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    // Six connections from three people, two tabs each: the room is full.
    const sockets = [];
    for (const userId of [1, 1, 2, 2, 3, 3]) {
      sockets.push(await join(port, 'alpha-000000', userId));
    }
    await settle();
    assert.equal(sockets.filter((s) => welcomeOf(s)).length, 6, 'all six are in');

    const turnedAway = await join(port, 'alpha-000000', 4);
    await settle();

    assert.equal(welcomeOf(turnedAway), undefined, 'the seventh gets no welcome');
    assert.equal(turnedAway.closed.code, 4002);
    assert.match(turnedAway.closed.reason, /full/i);

    for (const socket of sockets) socket.close();
  } finally {
    await server.close();
  }
});

// A signal is addressed to a peer id, so one tab can be talked to without the
// other hearing it — which is what makes a mesh between tabs work at all.
test('a signal to one tab does not reach the other', async () => {
  const server = startServer();
  const port = await server.listen();

  try {
    const tabOne = await join(port, 'alpha-000000', 1);
    const tabTwo = await join(port, 'alpha-000000', 1);
    const other = await join(port, 'alpha-000000', 2);
    await settle();

    const oneId = welcomeOf(tabOne).peerId;
    other.send(JSON.stringify({ type: 'signal', to: oneId, data: { description: { type: 'offer' } } }));
    await settle();

    assert.equal(tabOne.seen.filter((e) => e.type === 'signal').length, 1, 'the addressed tab gets it');
    assert.equal(tabTwo.seen.filter((e) => e.type === 'signal').length, 0, 'the other tab does not');

    tabOne.close();
    tabTwo.close();
    other.close();
  } finally {
    await server.close();
  }
});
