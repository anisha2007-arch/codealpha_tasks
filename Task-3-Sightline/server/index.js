// First, so a missing DATABASE_URL or JWT_SECRET stops the process before any
// of the rest of the app is loaded.
const config = require('./config');

const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const auth = require('./auth');
const realtime = require('./realtime');
const projects = require('./routes/projects');
const columns = require('./routes/columns');
const notifications = require('./routes/notifications');
const { boardRouter, taskRouter } = require('./routes/tasks');

const PORT = config.port;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
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

// Which browser tab made the request. Broadcasts carry it back as actorId so
// that tab can ignore the echo of its own change while every other tab, the
// same person's second tab included, still applies it.
app.use('/api', (req, res, next) => {
  const id = String(req.get('X-Client-Id') || '').slice(0, 64);
  req.clientId = id || null;
  next();
});

app.use('/api', auth.readSession);
app.use('/api', auth.router);
app.use('/api/columns', columns);
app.use('/api/notifications', notifications);
app.use('/api/projects/:id/tasks', boardRouter);
app.use('/api/projects', projects);
app.use('/api/tasks', taskRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = http.createServer(app);
realtime.attach(server);

db.init()
  .then(() => server.listen(PORT, () => console.log(`Sightline on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });
