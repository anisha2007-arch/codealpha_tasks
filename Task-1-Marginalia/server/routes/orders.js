const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { shippingFor } = require('../shipping');
const { CONTROL_CHARS_ERROR } = require('../text');
const { readAddress, readLines, readOrderId } = require('../order-input');

const router = express.Router();

const PLACED = 'Placed';
const CANCELLED = 'Cancelled';

// Where an order can go next, keyed by where it is now. 'Paid' is the payment
// step; the two terminal states are listed so an unknown status cannot fall
// through to "anything is allowed".
const TRANSITIONS = {
  Placed: ['Paid', CANCELLED],
  Paid: ['Shipped', CANCELLED],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

const STATUSES = Object.keys(TRANSITIONS);

function toOrder(row) {
  return {
    id: row.id,
    items: row.items,
    subtotal: Number(row.subtotal),
    shipping: Number(row.shipping),
    total: Number(row.total),
    address: row.address,
    status: row.status,
    // Served so the client can offer the right actions without keeping its own
    // copy of the state machine.
    nextStatuses: TRANSITIONS[row.status] || [],
    createdAt: row.created_at,
  };
}

router.get('/', requireLogin, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json(rows.map(toOrder));
});

// Prices always come from the database, never from the request body, and stock
// is checked under a row lock so two buyers cannot take the last copy.
router.post('/', requireLogin, async (req, res) => {
  const { lines, error } = readLines(req.body);
  if (error) return res.status(400).json({ error });

  const { address, missing, unsavable } = readAddress(req.body);
  if (missing) return res.status(400).json({ error: 'Name, address, and city are required.' });
  if (unsavable) return res.status(400).json({ error: CONTROL_CHARS_ERROR });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const items = [];
    let subtotal = 0;

    for (const line of lines) {
      const { rows } = await client.query('SELECT * FROM books WHERE id = $1 FOR UPDATE', [line.id]);
      const book = rows[0];
      if (!book) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One of the books is no longer available.' });
      }
      if (book.stock < line.quantity) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Only ${book.stock} copies of "${book.title}" are left.`,
        });
      }

      await client.query('UPDATE books SET stock = stock - $1 WHERE id = $2', [line.quantity, book.id]);

      const price = Number(book.price);
      subtotal += price * line.quantity;
      items.push({
        id: book.id,
        slug: book.slug,
        title: book.title,
        author: book.author,
        price,
        quantity: line.quantity,
      });
    }

    const shipping = shippingFor(subtotal);
    const { rows } = await client.query(
      `INSERT INTO orders (user_id, items, subtotal, shipping, total, address, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.userId, JSON.stringify(items), subtotal, shipping, subtotal + shipping,
       JSON.stringify(address), PLACED]
    );

    await client.query('COMMIT');
    res.status(201).json(toOrder(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Scoped to the signed-in user, so somebody else's order id reads as a 404
// rather than confirming that the order exists.
router.get('/:id', requireLogin, async (req, res) => {
  const id = readOrderId(req.params);
  if (!id) return res.status(404).json({ error: 'No such order.' });

  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'No such order.' });
  res.json(toOrder(rows[0]));
});

// Moves an order through TRANSITIONS. The order row is locked first, so two
// concurrent cancellations cannot both restock: the second one wakes up to find
// the status already 'Cancelled' and is refused.
router.post('/:id/status', requireLogin, async (req, res) => {
  const id = readOrderId(req.params);
  if (!id) return res.status(404).json({ error: 'No such order.' });

  const next = String(req.body.status || '').trim();
  if (!STATUSES.includes(next)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, req.userId]
    );
    const order = rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such order.' });
    }

    if (!(TRANSITIONS[order.status] || []).includes(next)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: order.status === next
          ? `That order is already ${next.toLowerCase()}.`
          : `An order that is ${order.status.toLowerCase()} cannot become ${next.toLowerCase()}.`,
      });
    }

    // Put the copies back. Sorted by id for the same reason checkout sorts:
    // one canonical lock order across every transaction that touches books.
    if (next === CANCELLED) {
      const items = [...(order.items || [])].sort((a, b) => a.id - b.id);
      for (const item of items) {
        await client.query('UPDATE books SET stock = stock + $1 WHERE id = $2', [item.quantity, item.id]);
      }
    }

    const updated = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [next, id]
    );

    await client.query('COMMIT');
    res.json(toOrder(updated.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
