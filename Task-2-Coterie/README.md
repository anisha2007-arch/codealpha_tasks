# Coterie

A small social app, built for the CodeAlpha Full Stack Development internship (Task 2).

Most social apps put everyone in one timeline. Coterie is built around circles:
small rooms for one subject each, which a post can be filed under.

## Features

- Registration and sign-in with a bcrypt-hashed password and an httpOnly session cookie
- Profiles with a display name, bio, and post, follower, and following counts
- Posts, optionally filed to a circle, with comments and likes
- Follow and unfollow, with browsable follower and following lists, and an
  Everyone view for finding new people
- Circles you can join or leave, each with its own feed
- A home feed of your own posts, the people you follow, and the circles you have
  joined
- People search

## Circles are open rooms

Joining a circle subscribes you to it. It does not gate it.

You can post into a circle you have not joined, and the post is accepted —
membership is consulted when building your home feed and nowhere on the write
path. So "join" means "put this in my feed", not "let me in", and leaving a
circle does not take your posts out of it.

That is deliberate, but the wording on the circles page — "Join the ones you
want in your feed" — only describes half of it, so it is worth saying plainly:
there is no such thing as a private circle here. Anyone signed in can post to
any circle and read any circle's feed, joined or not.

## Tech stack

- Frontend: HTML, CSS, vanilla JavaScript (no build step)
- Backend: Node.js, Express
- Database: PostgreSQL
- Docker Compose for local setup

## Running it

Requires Docker Desktop.

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Open http://localhost:4001 and create an account. The five starter circles are
seeded by `db/schema.sql`.

## Layout

```
server/index.js            express app and error handling
server/config.js           required environment, checked at boot
server/db.js               pool, schema on boot, the toggleLink transaction
server/auth.js             register, sign in, sign out, session middleware
server/ids.js              route parameters that name a database row
server/queries/            the shared SELECT fragments and their mappers
server/routes/             posts, comments, users, circles
public/js/post-card.js     one post: markup, like, delete
public/js/comment-thread.js the thread underneath it
public/js/html.js          escaping and the markup built on it
public/js/format.js        relative times
public/js/chrome.js        top bar and toast
public/                    pages, css/
test/                      node --test suites, no database needed
db/schema.sql              tables and the seed circles
```

Likes, follows, and memberships are join tables with composite primary keys, so
the database cannot hold a duplicate row. Toggling one is a delete followed by
an insert, which two clicks at once can interleave, so `db.toggleLink` does the
delete with `RETURNING` and the insert with `ON CONFLICT DO NOTHING`: the loser
of the race writes nothing rather than failing on the primary key. The Like,
Follow, and Join buttons also stay disabled until their request comes back.
`follows` has a check constraint that stops anyone following themselves.

Avatars are initials coloured from the handle, so there are no uploads to
store or serve.

## Shared queries

`server/queries/` holds the three SELECT fragments that more than one route
needs — posts, profiles, and circles — with their mappers. They used to live in
`routes/posts.js`, which meant `routes/circles.js` and `routes/users.js` each
required a *route module* to borrow a query constant from it.

Every fragment takes the same positional contract: **`$1` is the id of the
person looking**, so a `WHERE` clause appended to one starts at `$2`. That holds
even where the viewer and the subject are the same person, which is a place it
used to be satisfied only by accident.

## Tests

```bash
npm install
npm test
```

The suite covers the like button, which is one control that can be clicked
twice before the first request comes back: that toggling twice returns both the
row and the count to where they started, that the count is taken inside the
same transaction as the write, and that liking a post that has since been
deleted is a 404 rather than a 500.

`social-edges.test.js` runs the awkward corners of the social graph against an
in-memory SQLite database holding the real schema, so the primary keys and the
`ON DELETE` rules are the ones that ship: following twice toggles rather than
duplicating, a handle resolves whatever case the URL uses, a 300-character bio
is allowed and 301 is not, posts outlive a deleted circle and still render, and
deleting a post takes its comments and likes with it.
