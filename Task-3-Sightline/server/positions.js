// Where a card sits in its column, and what to do when two of them want the
// same slot. Shared by the routes that write a position: creating a task,
// patching one, and renumbering a whole column.

// Postgres integers stop here, and a position past the end of the list is
// meaningless anyway. 1e30 used to go straight through and come back as
// "integer out of range" from the driver.
const MAX_POSITION = 2147483647;

// Contention, in the two forms it reaches us as.
//
// 23505: two cards want the same slot in a column. The unique constraint is
// the backstop for a lock that was somehow missed — or for a client that asks
// for an absurd position and gets it clamped onto one already taken.
//
// 40P01: Postgres picked this transaction to break a deadlock. This one used
// to fall through and become a 500, which is why a contention event that the
// client already knows how to retry surfaced as "Something went wrong."
// instead. Row locks are ordered now so it should not happen at all, but
// "should not happen" is not a reason to answer it with the wrong status.
//
// Either way it means the board moved underneath the drag, which is a 409.
const CONTENTION = new Set(['23505', '40P01']);

function asConflict(err) {
  if (!CONTENTION.has(err.code)) throw err;
  throw Object.assign(new Error('The board moved while you were dragging. Reload and try again.'), {
    status: 409,
  });
}

// null, '', [] and false all become 0 through Number(), which then clamped to
// 1 and silently moved the card to the top of its column on a 200. Only a real
// number, or a string that is one, is a position; everything else is null and
// the route answers 400.
function clampPosition(value) {
  if (typeof value === 'string' ? value.trim() === '' : typeof value !== 'number') return null;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 1), MAX_POSITION);
}

// The next free slot at the bottom of a column. Only safe under lockColumn:
// read and write are separate statements, so two writers without the lock read
// the same maximum and both claim it.
async function nextPosition(client, projectId, status) {
  const { rows } = await client.query(
    'SELECT coalesce(max(position), 0) + 1 AS pos FROM tasks WHERE project_id = $1 AND status = $2',
    [projectId, status]
  );
  return Math.min(rows[0].pos, MAX_POSITION);
}

module.exports = { MAX_POSITION, asConflict, clampPosition, nextPosition };
