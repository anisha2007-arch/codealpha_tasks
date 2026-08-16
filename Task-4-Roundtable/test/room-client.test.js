const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

// The three parts of a call that live entirely in the browser: a file transfer
// whose sender walks out, a whiteboard being caught up after a couple of
// hundred strokes, and a screen share the browser ends on the person's behalf.

const JS = path.join(__dirname, '..', 'public', 'js');

// jsdom has no canvas, so getContext returns null and anything that paints
// would throw. A recording stub is enough: none of this is about pixels.
function stubCanvas(window) {
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      arc() {}, fill() {}, setTransform() {}, scale() {},
      set lineWidth(v) {}, set strokeStyle(v) {}, set lineCap(v) {}, set lineJoin(v) {},
      set fillStyle(v) {},
    };
  };
}

function room({ scripts, extras = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
       <div id="files"></div>
       <canvas id="board"></canvas>
       <div id="palette"></div>
     </body>`,
    { url: 'https://localhost:4003/', pretendToBeVisual: true }
  );
  const { window } = dom;
  stubCanvas(window);

  window.Html = { escape: (s) => String(s == null ? '' : s) };
  Object.assign(window, extras);

  const context = vm.createContext(window);
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
  }
  return { window, context };
}

const run = (context, code) => vm.runInContext(code, context);
const plain = (value) => JSON.parse(JSON.stringify(value));

// -------------------------------------------------------------- file transfer

test('a peer who leaves mid-transfer fails that transfer and says who and why', () => {
  const failures = [];
  const { context } = room({
    scripts: ['channel-flow.js', 'transfer.js'],
    extras: { Peers: { channelFor: () => null, openChannelIds: () => [], openChannels: () => [] } },
  });

  context.__failed = failures;
  run(context, `Transfer.init({
    onProgress: () => {},
    onComplete: () => {},
    onFailed: (event) => __failed.push(event),
  })`);

  // Bea starts sending a file and gets one chunk in.
  run(context, `Transfer.startReceiving('bea', { id: 'f1', name: 'notes.pdf', size: 40000 })`);
  run(context, 'Transfer.receiveChunk("bea", new ArrayBuffer(16384))');

  // ...and then closes the tab.
  run(context, `Transfer.forget('bea', 'Bea')`);

  assert.equal(failures.length, 1, 'the half-finished transfer is reported once');
  assert.equal(failures[0].direction, 'in');
  assert.equal(failures[0].id, 'f1');
  assert.equal(failures[0].name, 'notes.pdf');
  assert.match(failures[0].reason, /Bea left before the file finished/);
});

test('leaving does not disturb a transfer from somebody else', () => {
  const failures = [];
  const { context } = room({
    scripts: ['channel-flow.js', 'transfer.js'],
    extras: { Peers: { channelFor: () => null, openChannelIds: () => [], openChannels: () => [] } },
  });
  context.__failed = failures;
  run(context, `Transfer.init({
    onProgress: () => {}, onComplete: () => {},
    onFailed: (event) => __failed.push(event),
  })`);

  run(context, `Transfer.startReceiving('bea', { id: 'f1', name: 'bea.pdf', size: 40000 })`);
  run(context, `Transfer.startReceiving('cal', { id: 'f2', name: 'cal.pdf', size: 40000 })`);
  run(context, 'Transfer.receiveChunk("bea", new ArrayBuffer(1024))');
  run(context, 'Transfer.receiveChunk("cal", new ArrayBuffer(1024))');

  run(context, `Transfer.forget('bea', 'Bea')`);

  assert.equal(failures.length, 1, 'only the one that lost its sender fails');
  assert.equal(failures[0].name, 'bea.pdf');

  // Cal's transfer is still live and still accepting chunks.
  run(context, 'Transfer.receiveChunk("cal", new ArrayBuffer(1024))');
  assert.equal(failures.length, 1, 'and the other one carries on');
});

test('forgetting a peer with nothing in flight reports nothing', () => {
  const failures = [];
  const { context } = room({
    scripts: ['channel-flow.js', 'transfer.js'],
    extras: { Peers: { channelFor: () => null, openChannelIds: () => [], openChannels: () => [] } },
  });
  context.__failed = failures;
  run(context, `Transfer.init({
    onProgress: () => {}, onComplete: () => {},
    onFailed: (event) => __failed.push(event),
  })`);

  run(context, `Transfer.forget('bea', 'Bea')`);
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------- whiteboard

function board(extras = {}) {
  const sent = [];
  const { window, context } = room({
    scripts: ['whiteboard.js'],
    extras: { Peers: { broadcast: (message) => sent.push(message) }, ...extras },
  });
  run(context, "Whiteboard.init(document.getElementById('board'), document.getElementById('palette'))");
  return { window, context, sent };
}

// Someone joining a call that has been running a while asks for the board and
// gets a snapshot back a round trip later. Live strokes are not held back while
// it is in flight, so the reply almost always lands on a board that already has
// something on it.
test('a newcomer catching up on 200 strokes keeps all of them', () => {
  const host = board();
  // The host has been drawing for a while.
  const strokes = Array.from({ length: 200 }, (_, i) => ({
    origin: 'host', n: i, colour: '#fff', width: 3,
    from: { x: i, y: i }, to: { x: i + 1, y: i + 1 },
  }));
  for (const stroke of strokes) run(host.context, `Whiteboard.receive(${JSON.stringify(stroke)})`);
  assert.equal(run(host.context, 'Whiteboard.snapshot().length'), 200);

  const newcomer = board();
  // Three strokes arrive live while the newcomer's request is in flight.
  for (let i = 200; i < 203; i += 1) {
    run(newcomer.context, `Whiteboard.receive(${JSON.stringify({
      origin: 'host', n: i, colour: '#fff', width: 3,
      from: { x: i, y: i }, to: { x: i + 1, y: i + 1 },
    })})`);
  }
  assert.equal(run(newcomer.context, 'Whiteboard.snapshot().length'), 3);

  // Then the snapshot lands.
  const snapshot = plain(run(host.context, 'Whiteboard.snapshot()'));
  run(newcomer.context, `Whiteboard.restore(${JSON.stringify(snapshot)})`);

  assert.equal(
    run(newcomer.context, 'Whiteboard.snapshot().length'), 203,
    'the newcomer ends with everything, not with whichever half arrived last'
  );

  // The replayed strokes came first, so they belong underneath.
  const merged = plain(run(newcomer.context, 'Whiteboard.snapshot()'));
  assert.deepEqual(merged.slice(0, 3).map((s) => s.n), [0, 1, 2], 'the replay is underneath');
  assert.deepEqual(merged.slice(-3).map((s) => s.n), [200, 201, 202], 'and the live ones on top');
});

test('a snapshot that arrives twice is not drawn twice', () => {
  const { context } = board();
  const strokes = Array.from({ length: 50 }, (_, i) => ({
    origin: 'host', n: i, colour: '#fff', width: 3,
    from: { x: i, y: i }, to: { x: i + 1, y: i + 1 },
  }));

  run(context, `Whiteboard.restore(${JSON.stringify(strokes)})`);
  assert.equal(run(context, 'Whiteboard.snapshot().length'), 50);

  run(context, `Whiteboard.restore(${JSON.stringify(strokes)})`);
  assert.equal(run(context, 'Whiteboard.snapshot().length'), 50, 'the second copy is recognised');
});

test('an empty or malformed snapshot leaves the board alone', () => {
  const { context } = board();
  run(context, `Whiteboard.receive(${JSON.stringify({
    origin: 'me', n: 1, colour: '#fff', width: 3, from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
  })})`);

  for (const junk of ['[]', 'null', 'undefined', '"not an array"', '42']) {
    run(context, `Whiteboard.restore(${junk})`);
    assert.equal(run(context, 'Whiteboard.snapshot().length'), 1, `restore(${junk}) changed nothing`);
  }
});

test('clearing the board tells everyone, and clearing on their behalf does not echo', () => {
  const { context, sent } = board();
  run(context, `Whiteboard.restore(${JSON.stringify([{
    origin: 'host', n: 0, colour: '#fff', width: 3, from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
  }])})`);

  run(context, 'Whiteboard.clear()');
  assert.equal(run(context, 'Whiteboard.snapshot().length'), 0);
  assert.deepEqual(plain(sent), [{ kind: 'board-clear' }], 'a local clear is announced');

  run(context, 'Whiteboard.clear(false)');
  assert.equal(sent.length, 1, 'somebody else’s clear is applied without being echoed back');
});

// -------------------------------------------------------------- screen share

// The browser puts its own "Stop sharing" bar on screen, and that is what most
// people press. It ends the track directly, so the page hears about it through
// the track's own 'ended' event rather than through its button.
test('the browser’s own Stop sharing ends the share and restores the camera', async () => {
  const swapped = [];
  const shareChanges = [];

  const cameraTrack = { kind: 'video', enabled: true, stop() {}, addEventListener() {} };
  let endedListener = null;
  const screenTrack = {
    kind: 'video', enabled: true, stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, fn) { if (type === 'ended') endedListener = fn; },
  };

  const { context } = room({
    scripts: ['media.js'],
    extras: {
      Peers: { replaceVideoTrack: async (track) => { swapped.push(track); } },
    },
  });

  context.navigator.mediaDevices = {
    getUserMedia: async () => ({
      getVideoTracks: () => [cameraTrack],
      getAudioTracks: () => [{ kind: 'audio', enabled: true, stop() {} }],
      getTracks: () => [cameraTrack],
    }),
    getDisplayMedia: async () => ({ getVideoTracks: () => [screenTrack] }),
  };

  context.__onShare = (sharing) => shareChanges.push(sharing);
  run(context, 'Media.init({ onShareChange: (s) => __onShare(s) })');
  await run(context, 'Media.start()');

  context.__ended = false;
  await run(context, 'Media.startScreenShare(() => { __ended = true; })');

  assert.equal(run(context, 'Media.sharingScreen()'), true, 'the share is running');
  assert.deepEqual(swapped, [screenTrack], 'and the screen is what peers are being sent');
  assert.deepEqual(shareChanges, [true]);
  assert.ok(endedListener, 'the page is listening for the browser ending it');

  // The person presses the browser's own Stop sharing.
  endedListener();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(run(context, 'Media.sharingScreen()'), false, 'the share is over');
  assert.equal(screenTrack.stopped, true, 'the capture is released');
  assert.deepEqual(swapped, [screenTrack, cameraTrack], 'peers are put back on the camera');
  assert.deepEqual(shareChanges, [true, false], 'and the banner comes down');
  assert.equal(context.__ended, true, 'the page is told, so its button can catch up');
});

test('stopping the share from the page does the same thing', async () => {
  const swapped = [];
  const cameraTrack = { kind: 'video', enabled: true, stop() {}, addEventListener() {} };
  const screenTrack = {
    kind: 'video', enabled: true, stopped: false,
    stop() { this.stopped = true; }, addEventListener() {},
  };

  const { context } = room({
    scripts: ['media.js'],
    extras: { Peers: { replaceVideoTrack: async (track) => { swapped.push(track); } } },
  });
  context.navigator.mediaDevices = {
    getUserMedia: async () => ({
      getVideoTracks: () => [cameraTrack],
      getAudioTracks: () => [{ kind: 'audio', enabled: true, stop() {} }],
      getTracks: () => [cameraTrack],
    }),
    getDisplayMedia: async () => ({ getVideoTracks: () => [screenTrack] }),
  };

  run(context, 'Media.init({ onShareChange: () => {} })');
  await run(context, 'Media.start()');
  await run(context, 'Media.startScreenShare(() => {})');
  await run(context, 'Media.stopScreenShare()');

  assert.equal(run(context, 'Media.sharingScreen()'), false);
  assert.equal(screenTrack.stopped, true);
  assert.deepEqual(swapped, [screenTrack, cameraTrack]);
});
