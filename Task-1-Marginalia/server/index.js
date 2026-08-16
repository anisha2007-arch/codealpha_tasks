// First, so a missing DATABASE_URL or JWT_SECRET stops the process before any
// of the rest of the app is loaded.
const config = require('./config');

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const auth = require('./auth');
const books = require('./routes/books');
const orders = require('./routes/orders');
const shipping = require('./shipping');

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
app.use('/api/books', books);
app.use('/api/orders', orders);

// So the basket page shows the same shipping rule that checkout charges.
app.get('/api/shipping', (req, res) =>
  res.json({ fee: shipping.SHIPPING_FEE, freeOver: shipping.FREE_SHIPPING_OVER }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`Marginalia on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });
