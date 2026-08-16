const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { authorise } = require('./signal-session');

// Room slug -> Map of peerId -> socket. The server never sees media or file
// contents; it only relays the offers, answers, and ICE candidates that let
// two browsers connect to each other directly.
const rooms = new Map();

const MAX_PEERS = 6;

// And how many of those places one account may hold.
//
// The room cap counts sockets, so without this one person with six tabs fills
// a six-person room on their own and everybody else is told it is full —
// confirmed with six sockets carrying one cookie, the seventh closed 4002.
// Three leaves room for somebody genuinely on a laptop and a phone while
// keeping a single account from taking the room.
const MAX_PER_USER = 3;

// A browser that is force-quit, or a laptop that goes to sleep, leaves a TCP
// connection that is open as far as this process is concerned. ws does not
// detect that on its own, so without a heartbeat three dead tabs hold half the
// room and the fourth real person is told the room is full.
const PING_INTERVAL_MS = 25 * 1000;

// One row per visit, not one per socket. Reconnects back off only as far as
// fifteen seconds, so somebody on flaky mobile data would otherwise write a
// row every fifteen seconds for the length of the meeting and bury the join
// log the table exists to keep.
const VISIT_DEDUPE_MINUTES = 15;

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function peersIn(slug) {
  return rooms.get(slug) || new Map();
}

function announce(slug, payload, exceptPeerId) {
  for (const [peerId, socket] of peersIn(slug)) {
    if (peerId !== exceptPeerId) send(socket, payload);
  }
}

function removePeer(socket) {
  const room = rooms.get(socket.roomSlug);
  if (!room) return;
  room.delete(socket.peerId);
  if (room.size === 0) rooms.delete(socket.roomSlug);
  else announce(socket.roomSlug, { type: 'peer-left', peerId: socket.peerId });
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/signal' });

  // This listener is async, so anything that rejects inside it becomes an
  // unhandled rejection and takes the whole process down. Every room lives in
  // memory, so that would end every call on the server, not just this one: a
  // transient database error during one join must not cost anybody else theirs.
  // Sockets that stop answering are terminated, which fires 'close' and frees
  // their slot in the room.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    // Registered before the first await, so a client that gives up while the
    // room lookup is still running is still cleaned up.
    socket.on('close', () => removePeer(socket));
    socket.on('error', () => removePeer(socket));

    try {
      const session = await authorise(req);
      if (!session) return socket.close(4001, 'Sign in and pick a room that exists.');

      // 'close' may already have fired while the lookup was running. Taking a
      // slot now would hold it for a socket that is gone.
      if (socket.readyState !== socket.OPEN) return;

      const room = rooms.get(session.slug) || new Map();
      if (room.size >= MAX_PEERS) return socket.close(4002, `This room is full (${MAX_PEERS} people).`);

      const mine = [...room.values()].filter((peer) => peer.userId === session.userId).length;
      if (mine >= MAX_PER_USER) {
        return socket.close(4003, `You already have this room open in ${MAX_PER_USER} tabs.`);
      }

      socket.peerId = crypto.randomUUID();
      socket.roomSlug = session.slug;
      socket.displayName = session.name;
      socket.userId = session.userId;

      // `self` marks a peer that is this same account in another tab. Opening
      // the room twice puts you in a real call with yourself, which is
      // coherent, but the tile carrying your own voice back has to be muted
      // and the roster has to be able to tell the two entries apart — they
      // are otherwise byte-identical. It is computed per recipient rather
      // than sent as a user id, so nobody learns anybody else's.
      const existing = [...room].map(([peerId, peer]) => ({
        peerId,
        name: peer.displayName,
        self: peer.userId === session.userId,
      }));
      room.set(socket.peerId, socket);
      rooms.set(session.slug, room);

      await db.query(
        `INSERT INTO room_visits (room_id, user_id)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM room_visits
           WHERE room_id = $1 AND user_id = $2
             AND joined_at > now() - ($3 || ' minutes')::interval
         )`,
        [session.roomId, session.userId, String(VISIT_DEDUPE_MINUTES)]
      );

      // The newcomer is told who is already here and calls each of them, so two
      // peers never send each other an offer at the same time.
      send(socket, { type: 'welcome', peerId: socket.peerId, name: session.name, peers: existing });

      // Sent one at a time rather than through announce(), because whether the
      // newcomer is "you, again" is different for each person hearing it.
      for (const [peerId, peer] of room) {
        if (peerId === socket.peerId) continue;
        send(peer, {
          type: 'peer-joined',
          peerId: socket.peerId,
          name: session.name,
          self: peer.userId === session.userId,
        });
      }

      socket.on('message', (raw) => relay(socket, raw));
    } catch (err) {
      console.error('Signalling connection failed:', err);
      removePeer(socket);
      socket.close(1011, 'Something went wrong.');
    }
  });

  return wss;
}

// Relays one message to one named peer in the same room. A peer id from
// another room is ignored, so a client cannot reach outside its own call.
function relay(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type !== 'signal' || !message.to) return;

  const target = peersIn(socket.roomSlug).get(message.to);
  if (!target) return;

  send(target, {
    type: 'signal',
    from: socket.peerId,
    name: socket.displayName,
    data: message.data,
  });
}

module.exports = { attach, MAX_PEERS, MAX_PER_USER };
