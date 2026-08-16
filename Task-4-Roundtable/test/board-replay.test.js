const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

// Catching a newcomer up on the whiteboard, at a stroke count that used to
// kill the call.
//
// This is in the fast suite rather than the PostgreSQL tier because it needs
// no database and no real browser — but it is the test that was missing, so it
// is worth being explicit about what it does and does not stand in for.
//
// A data channel refuses a message over 262144 bytes, and refuses it in the
// worst possible way: send() returns normally, an 'error' event arrives a
// moment later, and the browser closes the channel. jsdom has no RTCDataChannel
// and so has no limit to exceed, which is exactly why the bug survived a green
// suite. What can be asserted without one is the thing that actually matters:
// that no single message the replay produces comes anywhere near the limit,
// and that a receiver reassembles all of them.
//
// The channel below is a stand-in with the real limit and the real failure
// mode, so a regression fails here the way it failed in the browser.

const JS = path.join(__dirname, '..', 'public', 'js');

// Chromium negotiates a=max-message-size:262144. Measured on a live channel:
// 262144 bytes delivered and the channel stayed open; 262145 was not delivered
// and the channel closed.
const MAX_MESSAGE_BYTES = 262144;

function context(scripts, extras) {
  const dom = new JSDOM(
    '<!doctype html><body><canvas id="board"></canvas><div id="palette"></div></body>',
    { url: 'https://localhost:4003/', pretendToBeVisual: true }
  );
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    set lineWidth(v) {}, set strokeStyle(v) {}, set lineCap(v) {},
  });
  Object.assign(window, extras);

  const ctx = vm.createContext(window);
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext("Whiteboard.init(document.getElementById('board'), document.getElementById('palette'))", ctx);
  return ctx;
}

// A data channel that behaves like Chromium's: an oversized send does not
// throw, it fails afterwards and takes the channel with it.
function fakeChannel(deliver) {
  const listeners = {};
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    sizes: [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    send(payload) {
      if (this.readyState !== 'open') throw new Error('InvalidStateError');
      const bytes = Buffer.byteLength(payload);
      this.sizes.push(bytes);
      if (bytes > MAX_MESSAGE_BYTES) {
        setTimeout(() => {
          this.readyState = 'closed';
          for (const fn of listeners.error || []) fn({ error: new Error('OperationError') });
          for (const fn of listeners.close || []) fn({});
        }, 0);
        return;
      }
      setTimeout(() => deliver(payload), 0);
    },
  };
}

// A stroke as extend() builds one. The coordinates are a pixel offset divided
// by a rect width, so they are full-precision doubles — which is what makes a
// stroke about 160 bytes rather than about 100.
function strokeAt(i) {
  return {
    id: `host-${i + 1}`,
    from: { x: (513 + (i % 97)) / 1063.3333740234375, y: (364 + (i % 89)) / 708.6666870117188 },
    to: { x: (514 + ((i + 1) % 97)) / 1063.3333740234375, y: (365 + ((i + 1) % 89)) / 708.6666870117188 },
    colour: '#ffd166',
    width: 3,
  };
}

const settle = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

// Replays `count` strokes from a host to a newcomer over one channel.
async function replay(count) {
  const newcomer = context(
    ['whiteboard.js', 'channel-flow.js', 'board-sync.js', 'channel-messages.js'],
    {
      Peers: { broadcast() {}, channelFor: () => null },
      Transfer: { receiveChunk() {}, startReceiving() {}, finishReceiving() {} },
    }
  );

  const channel = fakeChannel((payload) => {
    newcomer.__payload = payload;
    vm.runInContext('ChannelMessages.receive("host", "Host", __payload)', newcomer);
  });

  const host = context(
    ['whiteboard.js', 'channel-flow.js', 'board-sync.js', 'channel-messages.js'],
    {
      Peers: { broadcast() {}, channelFor: () => channel },
      Transfer: { receiveChunk() {}, startReceiving() {}, finishReceiving() {} },
    }
  );
  for (let i = 0; i < count; i += 1) {
    vm.runInContext(`Whiteboard.receive(${JSON.stringify(strokeAt(i))})`, host);
  }

  vm.runInContext(
    'ChannelMessages.receive("newcomer", "New", JSON.stringify({ kind: "board-request" }))',
    host
  );
  await settle();

  return { host, newcomer, channel };
}

// 2,000 strokes is roughly half a minute of drawing, and the single-message
// version died at about 1,620.
test('a board too big for one message still reaches a newcomer', async () => {
  const { host, newcomer, channel } = await replay(2000);

  assert.equal(vm.runInContext('Whiteboard.snapshot().length', host), 2000);
  assert.equal(
    vm.runInContext('Whiteboard.snapshot().length', newcomer), 2000,
    'the newcomer gets every stroke, not a blank board'
  );
  assert.equal(channel.readyState, 'open', 'and the channel is still alive');
});

test('no message the replay sends comes near the data channel limit', async () => {
  for (const count of [350, 1600, 2000, 5000]) {
    const { channel, newcomer } = await replay(count);
    const biggest = Math.max(...channel.sizes);

    assert.ok(
      biggest <= MAX_MESSAGE_BYTES,
      `${count} strokes produced a ${biggest}-byte message, over the ${MAX_MESSAGE_BYTES} limit`
    );
    // Not just under it: far enough under that a peer with a smaller limit,
    // or a stroke shape that grows, still has room.
    assert.ok(
      biggest < MAX_MESSAGE_BYTES / 4,
      `${count} strokes produced a ${biggest}-byte message, too close to the limit for comfort`
    );
    assert.equal(vm.runInContext('Whiteboard.snapshot().length', newcomer), count);
  }
});

// The failure this replaces was not "the board is incomplete" but "everything
// on that channel stops": no further strokes, and no file transfer in either
// direction, with the call still reading Connected.
test('the channel still carries strokes after a large replay', async () => {
  const { newcomer, channel } = await replay(5000);
  assert.equal(channel.readyState, 'open');

  channel.send(JSON.stringify({ kind: 'stroke', stroke: strokeAt(99999) }));
  await settle();

  assert.equal(
    vm.runInContext('Whiteboard.snapshot().length', newcomer), 5001,
    'a live stroke sent after the replay still arrives'
  );
});

// A replay that is cut off halfway paints nothing, rather than painting an
// arbitrary prefix of somebody else's board.
test('a replay that never finishes is not painted', async () => {
  const newcomer = context(
    ['whiteboard.js', 'channel-flow.js', 'board-sync.js', 'channel-messages.js'],
    {
      Peers: { broadcast() {}, channelFor: () => null },
      Transfer: { receiveChunk() {}, startReceiving() {}, finishReceiving() {} },
    }
  );

  const deliver = (payload) => {
    newcomer.__payload = payload;
    vm.runInContext('ChannelMessages.receive("host", "Host", __payload)', newcomer);
  };

  deliver(JSON.stringify({ kind: 'board-begin', id: 'b1', count: 4 }));
  deliver(JSON.stringify({ kind: 'board-chunk', id: 'b1', strokes: [strokeAt(0), strokeAt(1)] }));

  assert.equal(vm.runInContext('Whiteboard.snapshot().length', newcomer), 0,
    'nothing is painted before the end marker');
  assert.equal(vm.runInContext('BoardSync.pending("host")', newcomer), 2,
    'but what arrived is being held');

  // The sender leaves.
  vm.runInContext('BoardSync.forget("host")', newcomer);
  deliver(JSON.stringify({ kind: 'board-end', id: 'b1' }));

  assert.equal(vm.runInContext('Whiteboard.snapshot().length', newcomer), 0,
    'and an end marker after they left paints nothing');
});
