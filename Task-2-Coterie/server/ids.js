// Route parameters that name a database row.
//
// Without this, Number('abc') is NaN, the driver sends the literal "NaN" to
// Postgres, and a mistyped URL comes back as a 500 instead of a 400. Shared,
// because posts and comments both need it and neither should own it.

const MAX_ID = 2147483647; // The SERIAL primary keys are Postgres integers.

function parseId(value) {
  if (!/^[0-9]+$/.test(String(value == null ? '' : value))) return null;
  const id = Number(value);
  return id >= 1 && id <= MAX_ID ? id : null;
}

// For router.param('id', idParam): puts the parsed value on req.routeId.
function idParam(req, res, next, value) {
  const id = parseId(value);
  if (!id) return res.status(400).json({ error: 'That is not a valid id.' });
  req.routeId = id;
  next();
}

// For a router mounted under someone else's `:name`, where router.param does
// not fire.
function requireId(name, target = 'routeId') {
  return (req, res, next) => {
    const id = parseId(req.params[name]);
    if (!id) return res.status(400).json({ error: 'That is not a valid id.' });
    req[target] = id;
    next();
  };
}

module.exports = { MAX_ID, parseId, idParam, requireId };
