const { hasControlChars } = require('./text');

// Reading a checkout request: what the browser sent, turned into something the
// route can trust, or a message saying why it cannot be. Nothing here touches
// the database or decides a price — that is routes/orders.js, which is the
// point of the split.

// A cart of 3000 lines would hold a row lock on the whole catalogue for as long
// as the transaction ran, so the request is bounded before any lock is taken.
const MAX_LINES = 50;
const MAX_QUANTITY = 99;

// Every id in this schema is a Postgres `integer`, which is 32 bits wide, so
// anything above this is not an id that could exist. Number.isInteger(1e30) is
// true, so without the upper bound the value reached the query and came back as
// "invalid input syntax for type integer" — a 500 for what is a bad request.
// Coterie has the same bound in server/ids.js and Sightline in server/members.js.
const MAX_ID = 2147483647;

function readAddress(body) {
  const a = body.address || {};
  const address = {
    name: String(a.name || '').trim(),
    line1: String(a.line1 || '').trim(),
    city: String(a.city || '').trim(),
    postcode: String(a.postcode || '').trim(),
  };
  const missing = !address.name || !address.line1 || !address.city;
  // The address is stored as JSON, and a NUL byte is no more storable there
  // than in a text column: Postgres refuses the escape for it outright.
  const unsavable = Object.values(address).some((field) => hasControlChars(field));
  return { address, missing, unsavable };
}

// Cart lines arrive in whatever order the browser put them in. Two shoppers
// buying the same two books in opposite orders would each end up holding the
// row the other needed next, and Postgres would break the cycle by killing one
// of them (40P01). Merging duplicate ids and sorting ascending gives every
// checkout the same lock order, so they queue behind each other instead.
function readLines(body) {
  const malformed = { error: 'Your cart is empty or malformed.' };
  if (!Array.isArray(body.items) || body.items.length === 0) return malformed;

  const quantityById = new Map();
  for (const item of body.items) {
    const id = Number(item && item.id);
    const quantity = Math.floor(Number(item && item.quantity));
    if (!Number.isInteger(id) || id < 1 || id > MAX_ID) return malformed;
    if (!Number.isInteger(quantity) || quantity < 1) return malformed;
    quantityById.set(id, (quantityById.get(id) || 0) + quantity);
  }

  if (quantityById.size > MAX_LINES) {
    return { error: `An order can hold at most ${MAX_LINES} different books.` };
  }
  for (const quantity of quantityById.values()) {
    if (quantity > MAX_QUANTITY) {
      return { error: `At most ${MAX_QUANTITY} copies of any one book per order.` };
    }
  }

  const lines = [...quantityById]
    .map(([id, quantity]) => ({ id, quantity }))
    .sort((a, b) => a.id - b.id);
  return { lines };
}

function readOrderId(params) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 && id <= MAX_ID ? id : null;
}

module.exports = { readAddress, readLines, readOrderId, MAX_LINES, MAX_QUANTITY, MAX_ID };
