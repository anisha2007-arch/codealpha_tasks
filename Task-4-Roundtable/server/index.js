// First, so a missing DATABASE_URL or JWT_SECRET stops the process before any
// of the rest of the app is loaded.
const config = require('./config');

const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const auth = require('./auth');
const signalling = require('./signalling');
const rooms = require('./routes/rooms');
const { iceServers } = require('./ice');
const { rateLimit } = require('./rate-limit');

const PORT = config.port;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Sent to the browser so the ICE servers can be changed without a rebuild.
const ICE_SERVERS = iceServers();

const app = express();
// Behind the TLS terminator a real deployment needs, req.ip would otherwise be
// the proxy's address and the rate limiter would count everyone as one caller.
if (config.trustProxy) {
  // A bare number is a hop count, anything else a list of trusted addresses.
  const hops = Number(config.trustProxy);
  app.set('trust proxy', Number.isInteger(hops) ? hops : config.trustProxy);
}
app.use(express.json());
// Express 5 leaves req.body undefined when there was nothing to parse, so a
// request with no body or a non-JSON content type would make every handler
// that reads req.body.x throw. Give them an object to read from instead.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));

// A room link is the capability: anyone signed in who has the slug may join.
// That only holds if the slug cannot be found by asking, so the endpoints worth
// guessing at are throttled.
app.use('/api/login', rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many sign-in attempts. Wait a few minutes and try again.',
}));
// Capping sign-in and leaving this open only changes which door is used: a
// session is what the room lookup needs, and registering is the other way to
// get one. Slower than sign-in because nobody makes ten accounts in an hour by
// accident.
app.use('/api/register', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many accounts created from here. Wait a while and try again.',
}));
app.use('/api/rooms/:slug', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many room lookups. Wait a minute and try again.',
}));

app.use('/api', auth.readSession);
app.use('/api', auth.router);
app.use('/api/rooms', rooms);
app.get('/api/ice', (req, res) => res.json({ iceServers: ICE_SERVERS, maxPeers: signalling.MAX_PEERS }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = http.createServer(app);
signalling.attach(server);

db.init()
  .then(() => server.listen(PORT, () => console.log(`Roundtable on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });
