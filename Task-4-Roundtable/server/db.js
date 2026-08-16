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

module.exports = { init, query, pool };
