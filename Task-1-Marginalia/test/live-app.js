// Mounts real routers over an in-memory SQLite database and drives them over
// real HTTP, so a test exercises the handler, the real server/db.js, the query
// and the schema's constraints together. The same job supertest does, using
// what the project already has.

const http = require('node:http');
const express = require('express');

const { installPg } = require('./sqlite-db');
const { stubModule, unstub } = require('./helpers');

async function withApp({ appDir, mounts, userId = 1 }, run) {
  const pg = installPg(appDir);
  let current = userId;

  // Only auth is faked: signing every request in as whoever the test says,
  // instead of going through bcrypt and a cookie for each call.
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

  // The real db.js, with the real pool, the real init() and the real
  // toggleLink — all now talking to SQLite.
  delete require.cache[require.resolve('../server/db')];
  const db = require('../server/db');
  await db.init();

  for (const [, modulePath] of mounts) delete require.cache[require.resolve(modulePath)];

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    req.userId = current;
    next();
  });
  // [path, module] mounts the module itself; a third entry names the export to
  // mount, for the modules that ship more than one router. Order is the
  // caller's, because it is the caller's in server/index.js too.
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
    return await run({
      call,
      db,
      sql: pg.query,
      seen: pg.seen,
      signInAs: (id) => { current = id; },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [, modulePath] of mounts) delete require.cache[require.resolve(modulePath)];
    delete require.cache[require.resolve('../server/db')];
    unstub(stubbed);
    pg.uninstall();
  }
}

module.exports = { withApp };
