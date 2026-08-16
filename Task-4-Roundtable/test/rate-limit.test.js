const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { rateLimit } = require('../server/rate-limit');

// Capping sign-in and leaving registration open only changes which door is
// used: a session is what the room lookup needs, and registering is the other
// way to get one. These tests pin down both the limiter's own behaviour and
// which endpoints server/index.js actually puts it in front of.

function startLimited({ windowMs, max }) {
  const app = express();
  app.use(express.json());
  app.use('/thing', rateLimit({ windowMs, max, message: 'Too many.' }));
  // Always succeeds, so a 429 can only have come from the limiter.
  app.post('/thing', (req, res) => res.status(201).json({ ok: true }));

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        call: () => fetch(`${base}/thing`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }),
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('the limiter turns callers away once the window is full, with a Retry-After', async () => {
  const { call, stop } = await startLimited({ windowMs: 60 * 60 * 1000, max: 10 });
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await call()).status, 201, `call ${i + 1} should still get through`);
    }

    const blocked = await call();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '3600');
  } finally {
    await stop();
  }
});

// Read from the source rather than by booting the app, which would want a
// database. What matters is which paths the limiter is mounted on.
function limitedRoutes() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  return [...source.matchAll(/app\.use\('([^']+)', rateLimit\(/g)].map(([, route]) => route);
}

test('registration is throttled, not only sign-in', () => {
  const routes = limitedRoutes();
  assert.ok(routes.includes('/api/login'), 'sign-in should be limited');
  assert.ok(routes.includes('/api/register'), 'registration should be limited too');
});

// The limiter costs everyone something, so it goes only where guessing pays.
// Listing your own rooms and reading the ICE config are neither guessable nor
// worth slowing down.
test('the room list and the ICE config are left alone', () => {
  const routes = limitedRoutes();
  assert.ok(!routes.includes('/api/rooms'), 'the room list should not be limited');
  assert.ok(!routes.includes('/api/ice'), 'the ICE config should not be limited');
  assert.ok(routes.includes('/api/rooms/:slug'), 'the room lookup should still be limited');
});
