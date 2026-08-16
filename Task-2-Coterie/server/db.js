const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

let ready = null;

// The database container starts empty, so the app applies db/schema.sql on
// boot. Every statement in it is idempotent.
function init() {
  if (!ready) {
    ready = pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8')).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function query(text, params) {
  return pool.query(text, params);
}

// Advisory lock namespaces, so a post id and a circle id that happen to be the
// same number do not queue behind one another.
const LOCK_NAMESPACE = { likes: 1, follows: 2, memberships: 3 };

// Likes, follows, and memberships are all join tables with a composite primary
// key that one button toggles, so two clicks can be in flight at once. Plain
// DELETE-then-INSERT lets both requests delete nothing, both insert, and the
// loser violate the primary key; counting afterwards in a separate query can
// also report a total that the other request has already changed.
//
// So the toggle and its count run as one transaction behind an advisory lock on
// the subject. Requests about the same post, person, or circle queue instead of
// interleaving, and each returns the state and the count as of its own commit.
// DELETE ... RETURNING says whether this request was the one that removed the
// row, and ON CONFLICT DO NOTHING keeps the insert harmless either way.
//
// `table` and the column names are internal constants, never anything off the
// request. `values` is [subject id, user id]; the subject is what gets counted.
async function toggleLink(table, [subjectColumn, userColumn], values) {
  const namespace = LOCK_NAMESPACE[table];
  if (!namespace) throw new Error(`No lock namespace for ${table}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [namespace, values[0]]);

    const removed = await client.query(
      `DELETE FROM ${table} WHERE ${subjectColumn} = $1 AND ${userColumn} = $2 RETURNING 1`,
      values
    );
    if (removed.rowCount === 0) {
      await client.query(
        `INSERT INTO ${table} (${subjectColumn}, ${userColumn}) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        values
      );
    }

    const { rows } = await client.query(
      `SELECT count(*) FROM ${table} WHERE ${subjectColumn} = $1`,
      [values[0]]
    );
    await client.query('COMMIT');

    // Nothing deleted means this request is the one that turned the link on.
    return { on: removed.rowCount === 0, count: Number(rows[0].count) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { init, query, toggleLink, pool };
