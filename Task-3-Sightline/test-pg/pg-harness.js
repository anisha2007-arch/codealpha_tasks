// The second tier: real PostgreSQL, real transactions, real concurrency.
//
// The suite in test/ answers queries by matching SQL against regular
// expressions and returning canned rows. That is the right tool for asking
// what a handler does — a status code, a query it should not issue, an error
// code it has to translate — and it needs no database. But it means the
// "409 collision" test there injects a fabricated 23505 and never runs two
// transactions at all, which is how a 42% deadlock rate on concurrent
// cross-column reorders sat underneath a green suite.
//
// So these tests, and only these, need a real database. They are opt-in:
//
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm run test:pg
//
// Without that variable every test here skips with a message saying so, which
// is why `npm test` still works for somebody who has no Postgres to hand.
//
// The database is used, not created: the real db/schema.sql is applied (every
// statement in it is idempotent) and each test works on rows it inserts and
// deletes again. Point it at a scratch database, not at anything you mind
// losing.

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const URL_VAR = 'TEST_DATABASE_URL';
const databaseUrl = String(process.env[URL_VAR] || '').trim();

const skip = databaseUrl
  ? false
  : `needs a real PostgreSQL: set ${URL_VAR} and run \`npm run test:pg\``;

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
}

const SERVER_DIR = path.join(__dirname, '..', 'server');

// Every server module, not just the routers being mounted.
//
// Each run ends its pool when it finishes, and modules that captured `db` at
// require time — members.js, realtime.js, queries/tasks.js — would otherwise
// carry that dead pool into the next test while the routers around them got a
// fresh one. That failed as 60 identical 500s in the second test of a file and
// nothing at all when the same test ran on its own.
function purgeServerModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SERVER_DIR)) delete require.cache[key];
  }
}

function loadDb() {
  return require('../server/db');
}

// Mounts the real routers over the real database and drives them over real
// HTTP. Only auth is faked — membership, the advisory lock, the transaction
// and the row locks are all the real ones, which is the entire point.
async function withApp({ mounts, userId = 1 }, run) {
  const { stubModule, unstub } = require('../test/helpers');

  // Before the auth stub goes in, or the purge would take it straight out.
  purgeServerModules();

  let current = userId;
  const stubbed = [
    stubModule('../server/auth', {
      requireLogin: (req, res, next) => {
        if (!current) return res.status(401).json({ error: 'Please sign in.' });
        next();
      },
      readSession: (req, res, next) => next(),
      userIdFromToken: () => current,
      TOKEN_COOKIE: 'session',
      router: express.Router(),
    }),
  ];

  const db = loadDb();
  await db.init();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    req.userId = current;
    req.clientId = null;
    next();
  });
  for (const [mountAt, modulePath, exportName] of mounts) {
    const loaded = require(modulePath);
    app.use(mountAt, exportName ? loaded[exportName] : loaded);
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(base + path, {
      method: options.method || 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  };

  try {
    return await run({ call, db, signInAs: (id) => { current = id; } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end().catch(() => {});
    purgeServerModules();
    unstub(stubbed);
  }
}

function marker(name) {
  return `pgtest-${name}-${process.pid}-${Date.now().toString(36)}`;
}

module.exports = { skip, withApp, marker, URL_VAR };
