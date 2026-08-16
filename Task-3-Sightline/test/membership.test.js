const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fakeDb, stubModule, unstub } = require('./helpers');

// Membership is the access check for everything on a board, so it is the one
// piece of this app that has to be right. These tests pin down both halves of
// that: what the guard does, and that there is still only one of it.

function loadMembers(rows) {
  const db = fakeDb([[/FROM project_members WHERE project_id/, rows]]);
  const stubbed = [stubModule('../server/db', db)];
  delete require.cache[require.resolve('../server/members')];
  const members = require('../server/members');
  return { members, db, done: () => { delete require.cache[require.resolve('../server/members')]; unstub(stubbed); } };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('a member gets through, with their role attached', async () => {
  const { members, done } = loadMembers([{ role: 'owner' }]);
  try {
    const req = { params: { id: '7' }, userId: 3 };
    const res = fakeRes();
    let passed = false;

    await members.requireMember(req, res, () => { passed = true; });

    assert.equal(passed, true);
    assert.equal(req.projectId, 7);
    assert.equal(req.projectRole, 'owner');
  } finally {
    done();
  }
});

test('a stranger gets 404, not 403: the board does not confirm it exists', async () => {
  const { members, done } = loadMembers([]);
  try {
    const res = fakeRes();
    let passed = false;

    await members.requireMember({ params: { id: '7' }, userId: 99 }, res, () => { passed = true; });

    assert.equal(passed, false);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /No such project/);
  } finally {
    done();
  }
});

test('a project id that is not a number never reaches the database', async () => {
  const { members, db, done } = loadMembers([]);
  try {
    const res = fakeRes();
    await members.requireMember({ params: { id: 'abc' }, userId: 3 }, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.equal(db.seen.length, 0);
  } finally {
    done();
  }
});

test('requireOwner turns an ordinary member away', () => {
  const { members, done } = loadMembers([]);
  try {
    const res = fakeRes();
    let passed = false;

    members.requireOwner({ projectRole: 'member' }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);

    members.requireOwner({ projectRole: 'owner' }, fakeRes(), () => { passed = true; });
    assert.equal(passed, true);
  } finally {
    done();
  }
});

test('a task id that is not a number is a 400, not a 500 from the driver', async () => {
  const { members, db, done } = loadMembers([]);
  try {
    const res = fakeRes();
    // GET /api/tasks/abc/comments used to send the literal "abc" to Postgres.
    await members.loadTask({ params: { taskId: 'abc' }, userId: 3 }, res, () => {});

    assert.equal(res.statusCode, 400);
    assert.equal(db.seen.length, 0);
  } finally {
    done();
  }
});

// 1e30 is an integer as far as Number.isInteger is concerned, so it used to go
// straight past the guard and come back from the driver as "invalid input
// syntax for type integer: 1e+30" — a 500 on GET /api/tasks/1e30/comments and
// GET /api/projects/1e30/members.
test('an id too large for a Postgres integer is a 400, not a 500 from the driver', async () => {
  const { members, db, done } = loadMembers([]);
  try {
    const project = fakeRes();
    await members.requireMember({ params: { id: '1e30' }, userId: 3 }, project, () => {});
    assert.equal(project.statusCode, 400);

    const task = fakeRes();
    await members.loadTask({ params: { taskId: '1e30' }, userId: 3 }, task, () => {});
    assert.equal(task.statusCode, 400);

    assert.equal(db.seen.length, 0);
  } finally {
    done();
  }
});

test('positiveInt stops at the top of the integer column, not at Infinity', () => {
  const { members, done } = loadMembers([]);
  try {
    assert.equal(members.positiveInt('7'), 7);
    assert.equal(members.positiveInt(2147483647), 2147483647);
    assert.equal(members.positiveInt(2147483648), null);
    assert.equal(members.positiveInt('1e30'), null);
    assert.equal(members.positiveInt(Infinity), null);
  } finally {
    done();
  }
});

test('isMember answers null for a non-member and the role for a member', async () => {
  const yes = loadMembers([{ role: 'member' }]);
  try {
    assert.equal(await yes.members.isMember(1, 2), 'member');
  } finally {
    yes.done();
  }

  const no = loadMembers([]);
  try {
    assert.equal(await no.members.isMember(1, 2), null);
    assert.equal(await no.members.isMember(0, 2), null);
    assert.equal(await no.members.isMember(1, undefined), null);
  } finally {
    no.done();
  }
});

// The whole point of server/members.js is that the HTTP routes and the
// WebSocket handshake ask the same question. There used to be three copies of
// this query; this fails if a fourth appears.
test('the membership query exists in exactly one module', () => {
  const serverDir = path.join(__dirname, '..', 'server');
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        // Reads only. Removing somebody is a DELETE against the same table
        // and is a different job.
        if (/SELECT [^;]*FROM project_members WHERE project_id/.test(source.replace(/\s+/g, ' '))) {
          offenders.push(path.relative(serverDir, full));
        }
      }
    }
  })(serverDir);

  assert.deepEqual(offenders, ['members.js']);
});
