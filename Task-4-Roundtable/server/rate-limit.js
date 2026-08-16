// A small fixed-window rate limiter, held in memory.
//
// It guards the two endpoints where guessing pays: sign-in, and the room
// lookup, which answers "does this slug exist, and what is it called" for
// anybody with a session. One process holds the counters, which is what this
// app is; running several instances would want a shared store instead.

const WINDOW_CLEANUP_MS = 60 * 1000;

function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  // Old windows are dropped periodically so a long-running process does not
  // hold a counter for every address that ever called. unref() keeps this from
  // holding the process open on its own.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, WINDOW_CLEANUP_MS);
  if (sweeper.unref) sweeper.unref();

  return function limiter(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

module.exports = { rateLimit };
