// An in-memory SQLite database dressed up as node-postgres, so the tests can
// run the real schema and the real server/db.js without Docker.
//
// It stubs `pg` rather than server/db.js, which matters: db.js owns init(),
// the connection pool and toggleLink's transaction, and those are exactly the
// things worth exercising. Replacing db.js wholesale would have meant testing
// a reimplementation of them instead.
//
// SQLite is a real engine, so UNIQUE, CHECK and ON DELETE actually fire. It is
// not Postgres, so the translation below is deliberately narrow: it covers the
// dialect these apps actually use, and anything outside it fails loudly rather
// than quietly running something different from production.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Postgres types and syntax that SQLite spells differently, applied to
// db/schema.sql — the same file the real server applies on boot.
function translateSchema(sql) {
  return sql
    // Every statement in the real schema is idempotent so it can be re-applied
    // on every boot, and the ADD COLUMN ones exist to catch up a database that
    // predates a column. The CREATE TABLE above them is authoritative on a
    // brand new database, which is the only kind there is here.
    .replace(/ALTER TABLE\s+\w+\s+ADD COLUMN[^;]*;/gi, '')
    .replace(/\bSERIAL\s+PRIMARY KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
    .replace(/\bJSONB\b/gi, 'TEXT')
    .replace(/\bNUMERIC\b/gi, 'REAL')
    // SQLite only takes a literal after DEFAULT unless the expression is
    // parenthesised, so this has to run before the general now() substitution.
    .replace(/\bDEFAULT\s+now\(\)/gi, "DEFAULT (datetime('now'))")
    .replace(/\bnow\(\)/gi, "datetime('now')");
}

function translate(text) {
  return text
    .replace(/::int\[\]/gi, '')
    .replace(/::int\b/gi, '')
    .replace(/::text\b/gi, '')
    .replace(/\bILIKE\b/gi, 'LIKE')          // SQLite LIKE is ASCII-insensitive
    .replace(/\bnow\(\)/gi, "datetime('now')")
    .replace(/\bcount\(\*\)::int\b/gi, 'count(*)')
    // Postgres names a bare count(*) column "count"; SQLite names it "count(*)",
    // and the code reads rows[0].count.
    .replace(/SELECT\s+count\(\*\)\s+FROM/gi, 'SELECT count(*) AS count FROM')
    // Advisory and row locks have no SQLite equivalent, and SQLite serialises
    // writers anyway. Tests that care assert the app still issues them.
    .replace(/SELECT\s+pg_advisory_xact_lock\([^)]*\)/gi, 'SELECT 1')
    .replace(/\s+FOR UPDATE\b/gi, '');
}

// $1, $2 ... -> ?, with the values reordered to match. Postgres allows a
// parameter to appear more than once; SQLite's positional ? does not.
function translateQuery(text, params) {
  const order = [];
  const sql = text.replace(/\$(\d+)/g, (_, n) => {
    order.push(Number(n) - 1);
    return '?';
  });
  return { sql, values: order.map((i) => params[i]) };
}

function open(appDir) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  const schemaText = fs.readFileSync(path.join(appDir, 'db', 'schema.sql'), 'utf8');

  // node-postgres parses json and jsonb on the way out, so a route receives
  // order.items as an array. SQLite hands back a string, which spreads into
  // single characters and silently turns a restock loop into a no-op.
  const jsonColumns = new Set(
    [...schemaText.matchAll(/^\s*(\w+)\s+JSONB\b/gim)].map((m) => m[1].toLowerCase())
  );

  function revive(row) {
    for (const key of Object.keys(row)) {
      if (!jsonColumns.has(key.toLowerCase()) || typeof row[key] !== 'string') continue;
      try { row[key] = JSON.parse(row[key]); } catch { /* leave it as text */ }
    }
    return row;
  }

  const seen = [];

  async function query(text, params) {
    const source = String(text && text.text ? text.text : text);

    // init() applies the whole schema in one call. Everything else is a single
    // statement with bound parameters.
    if (params === undefined && /CREATE TABLE/i.test(source)) {
      db.exec(translateSchema(source));
      return { rows: [], rowCount: 0 };
    }

    const values = params || [];
    // Record what the app wrote, not what was run: a test asserting on FOR
    // UPDATE or an advisory lock is asking about the application's SQL.
    seen.push({ sql: source.replace(/\s+/g, ' ').trim(), params: values });

    const { sql, values: ordered } = translateQuery(translate(source), values);
    const bound = ordered.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    });

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      db.exec(sql);
      return { rows: [], rowCount: 0 };
    }

    const statement = db.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) {
      const rows = statement.all(...bound).map(revive);
      return { rows, rowCount: rows.length };
    }
    const info = statement.run(...bound);
    return { rows: [], rowCount: Number(info.changes) };
  }

  return { db, query, seen };
}

// Puts a fake `pg` in require's cache, so requiring the real server/db.js gets
// a pool backed by SQLite. Returns the handle plus an undo.
function installPg(appDir) {
  const handle = open(appDir);
  const client = { query: handle.query, release() {} };

  class Pool {
    query(text, params) { return handle.query(text, params); }
    async connect() { return client; }
    async end() {}
  }

  const resolved = require.resolve('pg');
  const saved = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: { Pool },
  };

  return {
    ...handle,
    uninstall() {
      if (saved) require.cache[resolved] = saved;
      else delete require.cache[resolved];
    },
  };
}

module.exports = { installPg, translate, translateSchema };
