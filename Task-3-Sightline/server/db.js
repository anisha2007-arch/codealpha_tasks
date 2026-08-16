const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { statusSqlList } = require('./statuses');

const pool = new Pool({ connectionString: config.databaseUrl });
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

let ready = null;

// The database container starts empty, so the app applies db/schema.sql on
// boot. Every statement in it is idempotent. The {{STATUSES}} placeholder is
// filled from server/statuses.js so the CHECK constraint and the code that
// validates a column key are the same list.
function schemaSql() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8').replaceAll('{{STATUSES}}', statusSqlList());
}

function init() {
  if (!ready) {
    ready = pool.query(schemaSql()).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function query(text, params) {
  return pool.query(text, params);
}

// Runs fn inside a transaction and hands it the client, so callers cannot
// forget the ROLLBACK or the release.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Serialises everyone writing to one column of one board. Positions are
// computed from a read and written straight back, so without this two people
// dropping a card into the same column at the same moment both read the same
// max and write the same position. The lock is released when the transaction
// ends, whichever way it ends.
function lockColumn(client, projectId, status) {
  return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sightline:${projectId}:${status}`]);
}

module.exports = { init, query, pool, transaction, lockColumn };
