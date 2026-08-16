# Roundtable

A video meeting room, built for the CodeAlpha Full Stack Development
internship (Task 4).

## Features

- Registration and sign-in with a bcrypt-hashed password and an httpOnly session cookie
- Multi-party video and audio over WebRTC, up to six people in a room
- Screen sharing, swapped in without renegotiating the call
- File sharing straight between browsers, in chunks, with a progress bar
- A shared whiteboard; strokes are sent over the same peer connections
- Rooms with a shareable link, and a record of who joined and when

## How the call is put together

The server only does signalling. It relays the offers, answers, and ICE
candidates that let two browsers find each other, and after that the media,
the files, and the whiteboard strokes travel directly between them. Nothing
that happens inside a call passes through the server or is written to disk.

Connections form a full mesh: each browser holds one `RTCPeerConnection` per
other person. That is simple and needs no media server, but the number of
connections grows with the square of the room size, which is why rooms are
capped at six. A larger call would need a selective forwarding unit.

The newcomer to a room is the one who sends offers to everyone already there,
so two peers never send each other an offer at the same time.

### Losing the connection and getting it back

A signalling socket that drops comes back with a new peer id, and everybody
else has already been told the old one left. So a second `welcome` tears the
mesh down — every connection closed, every tile removed — and builds it again
from the roster the server has just sent. Anything less leaves a client holding
stale peer ids, and the "we already have this peer" guard then stops it ever
negotiating again: connections that report `connected` with dead data channels,
video at under one frame a second, and a status line stuck on a cheerful green
"connecting" forever.

A path that merely goes quiet is treated as a hiccup, not a departure. On
`disconnected` or `failed` the connection is kept and ICE is restarted — by the
side that offered originally, or at that side's request if it was the other one
that noticed — with a widening delay, up to four attempts before the peer is
given up on. A candidate that straggles in for a peer we no longer have is
dropped rather than being allowed to conjure a connection that never negotiates.

The signalling server pings every socket every 25 seconds and terminates the
ones that stop answering, because `ws` does not notice half-open TCP on its own
and three force-quit browsers would otherwise hold half the room.

### What is being sent

Outbound video is "the screen if you are sharing one, the camera otherwise",
and a peer connection created mid-call is given that, so a late joiner sees the
shared screen like everyone else rather than the camera captured at page load.
The video mute button acts on that same track, so it cannot report the camera
off while a screen capture keeps streaming, and a banner stays on screen for as
long as the share is running.

## Encryption

WebRTC encrypts by default and cannot be turned off: audio and video are
carried over SRTP with keys agreed by DTLS, and the data channel used for
files and the whiteboard is DTLS too. Because the server never handles that
traffic, calls are end to end encrypted between participants.

Around the call: passwords are stored as bcrypt hashes, the session is a
signed JWT in an httpOnly, sameSite cookie, and the signalling socket is
closed on upgrade unless it presents that cookie and names a room that exists.
A relayed message can only reach a peer in the sender's own room.

This is the encryption WebRTC gives you. It is not a custom end-to-end scheme
layered on top, and it does not hide who is talking to whom from the server.

### The room link is the capability

Any signed-in person with the link may join; there is no per-room guest list,
which is what makes "send someone the link" work. That only holds if the link
cannot be found by asking, so the random part of a slug is 80 bits, and both
sign-in and the room lookup — which would otherwise answer "does this slug
exist, and what is it called" as fast as you can ask — are rate limited per
address.

## Tech stack

- Frontend: HTML, CSS, vanilla JavaScript, WebRTC (no build step)
- Backend: Node.js, Express, ws
- Database: PostgreSQL
- Docker Compose for local setup

## Running it

Requires Docker Desktop.

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Open http://localhost:4003, create a room, and open the same link in a second
browser window signed in as a different account.

## Deploying it

### HTTPS is not optional

`getUserMedia`, `getDisplayMedia` and the clipboard are only available in a
secure context. `localhost` counts; a plain `http://` address on any other host
does not, and the APIs are simply absent rather than denied. The room page
checks `window.isSecureContext` and says so plainly, instead of blaming your
camera permissions for something that was never a permissions problem.

The app itself speaks plain HTTP and the compose file publishes port 4003
directly, so put a TLS terminator in front of it. With Caddy, which gets a
certificate on its own, that is one file:

```
# Caddyfile
roundtable.example.com {
    reverse_proxy app:4003
}
```

```yaml
# add to docker-compose.yml, and drop the "ports" block from the app service
  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddydata:/data
    depends_on: [app]
```

The WebSocket upgrade needs no extra configuration in Caddy; behind nginx, pass
`Upgrade` and `Connection` through. Set `TRUST_PROXY=1` so the rate limiter
counts callers rather than the proxy.

### ICE, and when STUN is not enough

STUN only tells a browser its own public address. It is enough on most home and
office networks, but two peers behind symmetric NAT or a corporate firewall have
nothing to connect to, and the call fails with no diagnostic beyond
`connectionState === 'failed'`. That case needs TURN, which relays the media.

TURN takes a username and a credential, so it cannot be expressed as another
entry in `STUN_URLS` — it has its own three variables, and all three have to be
set together or the entry is ignored with a warning at boot:

```
STUN_URLS=stun:stun.l.google.com:19302
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

All four are in `.env.example`.

## Layout

```
server/index.js         express app, http server, ICE config endpoint
server/config.js        required environment, checked at boot
server/db.js            connection pool, applies db/schema.sql on boot
server/auth.js          register, sign in, sign out, shared token check
server/ice.js           STUN and TURN configuration from the environment
server/rate-limit.js    fixed-window limiter for sign-in and room lookup
server/signalling.js    WebSocket rooms, heartbeat, message relay
server/routes/rooms.js
public/js/peers.js      the mesh of peer connections, and its recovery
public/js/media.js      camera, microphone, screen share, outbound track
public/js/transfer.js   chunked file sending over the data channel
public/js/whiteboard.js
public/js/html.js       escaping and the markup built on it
public/js/format.js     relative times
public/js/chrome.js     top bar and toast
test/                   node --test suites, no database needed
db/schema.sql
```

## Tests

```bash
npm install
npm test
```

The suite drives real WebSockets against the signalling server with a scripted
database behind it. The rule it exists to protect is that a relayed message
cannot leave the room it was sent from: a peer id from another room is looked
up in the sender's own room, finds nothing, and goes nowhere. It also covers
the upgrade refusals, the room cap, the roster a newcomer is given, and the
guard that stops a reconnect writing a second visit row.

`signalling-two-tabs.test.js` covers one person in two windows: two peer ids for
one account, closing one tab leaving the other in the room, and both tabs
counting towards the room cap.

`room-client.test.js` covers the browser-side parts in jsdom: a sender who
leaves mid-transfer failing only their own file, a newcomer merging a 200-stroke
snapshot with the strokes that arrived while it was in flight, and the browser's
own "Stop sharing" bar putting everyone back on the camera.
