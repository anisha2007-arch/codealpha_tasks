// Required by server/index.js before anything else, so a missing value stops
// the process at boot instead of surfacing later as a generic 500 on the first
// register or sign-in.
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];

const missing = REQUIRED.filter((name) => !String(process.env[name] || '').trim());

if (missing.length) {
  for (const name of missing) {
    console.error(
      `Cannot start: ${name} is not set. Set it in ${ENV_FILE} ` +
        '(copy .env.example to .env and fill in the blanks).'
    );
  }
  if (missing.includes('DATABASE_URL')) {
    console.error('Under docker compose the app service supplies DATABASE_URL, so check docker-compose.yml too.');
  }
  process.exit(1);
}

module.exports = Object.freeze({
  databaseUrl: process.env.DATABASE_URL.trim(),
  jwtSecret: process.env.JWT_SECRET.trim(),
  port: Number(process.env.PORT) || 4000,
  isProduction: process.env.NODE_ENV === 'production',
});
