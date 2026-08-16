const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withApp } = require('./live-app');

// The awkward corners of a social graph, against a real SQLite database running
// the real schema — so the primary keys and the ON DELETE rules are the ones
// the app actually ships with, not a description of them.

const APP = path.join(__dirname, '..');

function app(run) {
  return withApp({
    appDir: APP,
    // Same order as server/index.js: the comment router has to be mounted
    // before /api/posts or /api/posts/:id would swallow its path.
    mounts: [
      ['/api/users', '../server/routes/users'],
      ['/api/posts/:id/comments', '../server/routes/comments', 'postComments'],
      ['/api/posts', '../server/routes/posts'],
      ['/api/comments', '../server/routes/comments', 'commentRouter'],
      ['/api/circles', '../server/routes/circles'],
    ],
  }, run);
}

async function people(db) {
  await db.query(
    `INSERT INTO users (handle, display_name, email, password_hash)
     VALUES ('ann','Ann','ann@example.com','x'), ('bee','Bee','bee@example.com','x')`,
    []
  );
}

test('following twice is a toggle, and cannot leave two rows behind', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    const on = await call('/api/users/bee/follow', { method: 'POST' });
    assert.equal(on.status, 200);
    assert.equal(on.body.following, true);
    assert.equal(on.body.followerCount, 1);

    const off = await call('/api/users/bee/follow', { method: 'POST' });
    assert.equal(off.body.following, false, 'the second press unfollows');
    assert.equal(off.body.followerCount, 0);

    const again = await call('/api/users/bee/follow', { method: 'POST' });
    assert.equal(again.body.following, true);
    assert.equal(again.body.followerCount, 1, 'and never counts the same person twice');

    const { rows } = await db.query('SELECT count(*) AS n FROM follows', []);
    assert.equal(Number(rows[0].n), 1);
  });
});

// The count is what a double-click would inflate, so it is asserted after a
// pair of presses that were not awaited in turn.
test('a double-pressed follow settles on one row, not two', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    await Promise.all([
      call('/api/users/bee/follow', { method: 'POST' }),
      call('/api/users/bee/follow', { method: 'POST' }),
    ]);

    const { rows } = await db.query('SELECT count(*) AS n FROM follows', []);
    assert.ok(Number(rows[0].n) <= 1, 'at most one row exists whichever order they landed in');

    // Under Postgres what makes that safe is the advisory lock the toggle takes
    // before it reads. SQLite serialises writers on its own, so assert the lock
    // is still being asked for rather than pretend this proved it.
    assert.ok(
      seen.some((q) => /pg_advisory_xact_lock/.test(q.sql)),
      'the toggle still takes its advisory lock'
    );
  });
});

test('nobody can follow themselves, at the route and at the table', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    const refused = await call('/api/users/ann/follow', { method: 'POST' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /cannot follow yourself/i);

    await assert.rejects(
      () => db.query('INSERT INTO follows (followee_id, follower_id) VALUES ($1,$2)', [1, 1]),
      /CHECK constraint failed/,
      'and the schema would refuse it even if the route did not'
    );
  });
});

// Handles are stored lowercase. A link shared with different casing, or typed
// by hand, is the same person and used to come back as a 404.
test('a handle is found whatever case the URL uses', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    for (const spelling of ['bee', 'Bee', 'BEE', 'bEe']) {
      const profile = await call(`/api/users/${spelling}`);
      assert.equal(profile.status, 200, `/api/users/${spelling} should resolve`);
      assert.equal(profile.body.handle, 'bee');
    }

    const posts = await call('/api/users/BEE/posts');
    assert.equal(posts.status, 200);

    const followed = await call('/api/users/BEE/follow', { method: 'POST' });
    assert.equal(followed.status, 200);
    assert.equal(followed.body.following, true, 'and following works from the same URL');

    const missing = await call('/api/users/nobody');
    assert.equal(missing.status, 404, 'a handle that really is not there is still a 404');
  });
});

test('a bio of exactly 300 characters is allowed; 301 is not', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    const at = await call('/api/users/me', {
      method: 'PUT', body: { displayName: 'Ann', bio: 'x'.repeat(300) },
    });
    assert.equal(at.status, 200, '300 is the limit, not one past it');
    assert.equal(at.body.bio.length, 300);

    const over = await call('/api/users/me', {
      method: 'PUT', body: { displayName: 'Ann', bio: 'x'.repeat(301) },
    });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /under 300 characters/i);

    // And the refused one did not overwrite the stored bio.
    const { rows } = await db.query('SELECT bio FROM users WHERE id = $1', [1]);
    assert.equal(rows[0].bio.length, 300);
  });
});

// Circles are open: their posts are readable by anyone signed in, and joining
// only decides whether they show up in your own feed. Posting into one you have
// not joined is therefore allowed by design, and this pins that down so it is
// not "fixed" by accident later.
test('posting to a circle you have not joined is allowed, and does not join you', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    const posted = await call('/api/posts', {
      method: 'POST', body: { body: 'Hello from outside', circle: 'reading' },
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.circle.slug, 'reading');

    const { rows } = await db.query('SELECT count(*) AS n FROM memberships WHERE user_id = $1', [1]);
    assert.equal(Number(rows[0].n), 0, 'posting is not joining');

    const nonsense = await call('/api/posts', {
      method: 'POST', body: { body: 'Hello', circle: 'not-a-circle' },
    });
    assert.equal(nonsense.status, 400, 'but the circle still has to exist');
  });
});

// posts.circle_id is ON DELETE SET NULL, so a deleted circle leaves its posts
// behind with nothing to point at. The feed has to render them rather than drop
// them or fall over.
test('posts outlive their circle and still render', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    await call('/api/posts', { method: 'POST', body: { body: 'In a circle', circle: 'reading' } });
    await call('/api/posts', { method: 'POST', body: { body: 'No circle at all' } });

    await db.query('DELETE FROM circles WHERE slug = $1', ['reading']);

    const { rows } = await db.query('SELECT id, circle_id FROM posts ORDER BY id', []);
    assert.equal(rows.length, 2, 'the posts survive the circle');
    assert.equal(rows[0].circle_id, null, 'and are simply no longer filed anywhere');

    const feed = await call('/api/posts?scope=explore');
    assert.equal(feed.status, 200);
    assert.equal(feed.body.length, 2);
    assert.deepEqual(feed.body.map((p) => p.circle), [null, null], 'both read as unfiled');
    assert.equal(feed.body[0].body, 'In a circle');
  });
});

test('deleting a post takes its comments and likes with it', async () => {
  await app(async ({ call, db, seen }) => {
    await people(db);

    const post = await call('/api/posts', { method: 'POST', body: { body: 'Say something' } });
    const id = post.body.id;

    await call(`/api/posts/${id}/comments`, { method: 'POST', body: { body: 'Something' } });
    await call(`/api/posts/${id}/like`, { method: 'POST' });

    assert.equal(Number((await db.query('SELECT count(*) AS n FROM comments', [])).rows[0].n), 1);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM likes', [])).rows[0].n), 1);

    const removed = await call(`/api/posts/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);

    assert.equal(Number((await db.query('SELECT count(*) AS n FROM comments', [])).rows[0].n), 0);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM likes', [])).rows[0].n), 0);
  });
});
