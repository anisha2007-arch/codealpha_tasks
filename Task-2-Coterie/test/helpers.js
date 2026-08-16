// Test support. No dependencies beyond Node: the whole suite runs on the
// built-in test runner, so `npm test` needs nothing installed that `npm start`
// does not already need.
//
// The routes under test are exercised over real HTTP, against a stand-in for
// server/db.js that answers by pattern rather than by talking to Postgres.
// That keeps the thing being tested honest — the actual handler, the actual
// status codes — without a database in the loop.

const http = require('http');
const express = require('express');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function squash(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// routes is a list of [pattern, rows]. rows may be an array or a function of
// the parameters. The first pattern that matches wins; an unmatched query is a
// test failure rather than an empty result, so a handler that starts asking
// something new cannot pass silently.
function fakeDb(routes) {
  const seen = [];

  async function query(text, params = []) {
    const sql = squash(text);
    seen.push({ sql, params });

    for (const [pattern, rows] of routes) {
      if (!pattern.test(sql)) continue;
      const result = typeof rows === 'function' ? rows(params) : rows;
      return { rows: result || [], rowCount: (result || []).length };
    }
    throw new Error(`No fake result for query: ${sql}`);
  }

  const client = { query, release() {} };
  return { query, pool: { connect: async () => client }, init: async () => {}, seen };
}

// Puts a module into require's cache under a real path, so anything that later
// requires it gets the double instead of the real thing.
function stubModule(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  return resolved;
}

function unstub(paths) {
  for (const resolved of paths) delete require.cache[resolved];
}

// Builds an app with one router mounted, a signed-in user, and the shared
// error handler the real server uses, so a thrown error is a 500 with a body
// rather than a hung socket.
async function withRouter({ db, routerPath, mountAt, userId = 1 }, run) {
  const stubbed = [
    stubModule('../server/db', db),
    stubModule('../server/auth', {
      requireLogin: (req, res, next) => next(),
      readSession: (req, res, next) => next(),
      router: express.Router(),
    }),
  ];
  delete require.cache[require.resolve(routerPath)];

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    req.userId = userId;
    next();
  });
  app.use(mountAt, require(routerPath));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run(async (path, options = {}) => {
      const res = await fetch(base + path, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, body };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[require.resolve(routerPath)];
    unstub(stubbed);
  }
}

module.exports = { fakeDb, withRouter, stubModule, unstub, squash };
