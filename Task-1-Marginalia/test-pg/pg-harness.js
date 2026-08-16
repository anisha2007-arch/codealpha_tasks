// The second tier: real PostgreSQL, real transactions, real concurrency.
//
// The suite in test/ runs against an in-memory SQLite dressed as node-postgres.
// That is the right tool for most of what it covers and it needs no Docker —
// but SQLite serialises writes globally, so a test that *looks* like it covers
// a race proves nothing about Postgres. Row locks, lock ordering and deadlock
// detection do not exist there to be got wrong.
//
// So these tests, and only these, need a real database. They are opt-in:
//
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm run test:pg
//
// Without that variable every test here skips with a message saying so, which
// is why `npm test` still works for somebody who has no Postgres to hand.
//
// The database is used, not created: the real db/schema.sql is applied (every
// statement in it is idempotent) and each test works on rows it inserts under
// its own marker and deletes afterwards. Point it at a scratch database, not
// at anything you mind losing.

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const URL_VAR = 'TEST_DATABASE_URL';
const databaseUrl = String(process.env[URL_VAR] || '').trim();

const skip = databaseUrl
  ? false
  : `needs a real PostgreSQL: set ${URL_VAR} and run \`npm run test:pg\``;

// config.js exits the process if these are missing, and it is required through
// db.js below.
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
}

const SERVER_DIR = path.join(__dirname, '..', 'server');

// Every server module, not just the routers being mounted.
//
// Each run ends its pool when it finishes, and any module that captured `db`
// at require time would otherwise carry that dead pool into the next test
// while the routers around it got a fresh one.
function purgeServerModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SERVER_DIR)) delete require.cache[key];
  }
}

function loadDb() {
  return require('../server/db');
}

// Mounts the real routers over the real database and drives them over real
// HTTP, so a request goes through the actual handler, the actual pool and the
// actual transaction. Only auth is faked, exactly as test/live-app.js does it.
async function withApp({ mounts, userId = 1 }, run) {
  const { stubModule, unstub } = require('../test/helpers');

  // Before the auth stub goes in, or the purge would take it straight out.
  purgeServerModules();

  let current = userId;
  const stubbed = [
    stubModule('../server/auth', {
      requireLogin: (req, res, next) => {
        if (!current) return res.status(401).json({ error: 'Please log in.' });
        next();
      },
      readSession: (req, res, next) => next(),
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

// A marker unique to one test run, so fixtures can be found and removed again
// without touching anything else in the database.
function marker(name) {
  return `pgtest-${name}-${process.pid}-${Date.now().toString(36)}`;
}

module.exports = { skip, withApp, marker, URL_VAR };
