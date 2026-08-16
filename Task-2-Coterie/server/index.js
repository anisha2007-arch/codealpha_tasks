// First, so a missing DATABASE_URL or JWT_SECRET stops the process before any
// of the rest of the app is loaded.
const config = require('./config');

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const auth = require('./auth');
const posts = require('./routes/posts');
const users = require('./routes/users');
const circles = require('./routes/circles');
const { postComments, commentRouter } = require('./routes/comments');

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

app.use('/api', auth.readSession);
app.use('/api', auth.router);
app.use('/api/posts/:id/comments', postComments);
app.use('/api/posts', posts);
app.use('/api/comments', commentRouter);
app.use('/api/users', users);
app.use('/api/circles', circles);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Coterie on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });
