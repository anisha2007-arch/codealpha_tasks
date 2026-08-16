// The room page. Wrapped in an IIFE so its names stay its own.
(() => {
  const slug = new URLSearchParams(location.search).get('room');
  const statusEl = document.getElementById('status');

  let me = null;
  let myPeerId = null;

  // Peers whose connection is not healthy, by peer id: { name, lost }. Kept
  // here because the status line has to describe the room as a whole, and a
  // failed call and an empty room are not the same news.
  const ailing = new Map();

  (async () => {
    me = await Api.requireUser();
    if (!me || !slug) return;

    // getUserMedia, getDisplayMedia and the clipboard all require a secure
    // context. On plain http anywhere but localhost they simply are not there,
    // and the old code reported that as a permissions problem, which blamed
    // the wrong thing and left no way to act on it.
    if (!window.isSecureContext) {
      return setStatus(
        'This page has to be served over HTTPS. Browsers only give a page the camera, '
          + 'the microphone and the clipboard on a secure origin — localhost counts, a plain '
          + 'http:// address on any other host does not.',
        'bad'
      );
    }

    let room;
    try {
      room = await Api.get(`/rooms/${encodeURIComponent(slug)}`);
    } catch (err) {
      return setStatus(err.message, 'bad');
    }
    document.getElementById('room-name').textContent = room.name;
    document.title = `${room.name} · Roundtable`;

    let stream;
    try {
      Media.init({ onShareChange: RoomControls.showSharing });
      stream = await Media.start();
    } catch {
      return setStatus('Roundtable needs permission to use your camera and microphone.', 'bad');
    }

    Tiles.setLocal(stream, me.name);
    Whiteboard.init(document.getElementById('board'), document.getElementById('palette'));
    Transfer.init({
      onProgress: TransferList.showProgress,
      onComplete: TransferList.showComplete,
      onFailed: TransferList.showFailed,
    });

    const { iceServers } = await Api.get('/ice');
    Peers.init({
      iceServers,
      localStream: stream,
      outboundVideoTrack: () => Media.outboundVideoTrack(),
      onTrack: (peerId, name, remote) => Tiles.add(peerId, name, remote),
      onPeerLeft: (peerId) => {
        ailing.delete(peerId);
        Transfer.forget(peerId, Tiles.nameOf(peerId));
        BoardSync.forget(peerId);
        Tiles.remove(peerId);
        describeRoom();
      },
      onPeerTrouble: (peerId, name) => {
        ailing.set(peerId, { name, lost: false });
        describeRoom();
      },
      onPeerRecovered: (peerId) => {
        ailing.delete(peerId);
        describeRoom();
      },
      onPeerLost: (peerId, name) => {
        ailing.set(peerId, { name, lost: true });
        describeRoom();
      },
      onChannelOpen: (peerId) => Peers.channelFor(peerId)?.send(JSON.stringify({ kind: 'board-request' })),
      onData: ChannelMessages.receive,
      // The channel carries the whiteboard and every file, so losing one is
      // worth saying out loud. Audio and video are on the peer connection and
      // keep working, which is exactly why this needs announcing: without it
      // the call looks fine and half of it silently is not.
      onChannelError: (peerId, name, detail) => {
        BoardSync.forget(peerId);
        Transfer.forget(peerId, name);
        console.warn(`Channel error with ${name}: ${detail}`);
        Chrome.toast(`Lost the whiteboard and file link to ${name}. Audio and video are unaffected.`);
      },
    });

    RoomControls.init({ onStatus: setStatus });
    connectSignalling();
  })();

  function connectSignalling() {
    Signal.on('welcome', ({ peerId, peers }) => {
      // A welcome after the first one means the socket dropped and came back
      // with a fresh identity. Everyone else has already been told our old
      // peer id left and has closed their side, and every id we are holding
      // for them is stale — so create() would hit its "already have this peer"
      // guard and never negotiate, and the call would stay silently dead.
      // Start the mesh again from the roster we have just been handed.
      if (myPeerId && myPeerId !== peerId) {
        Peers.reset();
        Tiles.reset();
      }
      myPeerId = peerId;

      peers.forEach(({ peerId: otherId, name, self }) => {
        Tiles.note(otherId, name, self);
        Peers.create(otherId, name, true);
      });
      describeRoom();
    });

    Signal.on('peer-joined', ({ peerId, name, self }) => {
      Tiles.note(peerId, name, self);
      setStatus(self ? 'You opened this room in another tab.' : `${name} joined.`, 'ok');
    });

    // Signals come from other people's browsers, so a late or malformed one is
    // an ordinary thing to receive, not a page error. Anything handleSignal
    // cannot apply is dropped here rather than becoming an uncaught rejection.
    Signal.on('signal', ({ from, name, data }) => {
      Peers.handleSignal(from, name, data).catch((err) => {
        console.warn('Ignored a signal that could not be applied:', err.message);
      });
    });
    Signal.on('peer-left', ({ peerId }) => Peers.remove(peerId));

    Signal.on('open', () => {
      if (myPeerId) setStatus('Reconnected. Setting the call up again…', 'warn');
    });

    Signal.on('closed', (event) => {
      if (event.code === 4001 || event.code === 4002 || event.code === 4003) {
        return setStatus(event.reason, 'bad');
      }
      // Not green. The call is on its own until the socket is back, and
      // saying "Connecting to the others" in a positive colour forever was
      // exactly the wrong thing to tell somebody whose call had just died.
      setStatus('Lost the connection to the room. Trying again…', 'warn');
    });

    Signal.connect(slug);
  }

  // Worst news first. A call that has failed must not read like a room nobody
  // has joined: they are still here and unreachable, which is a different
  // thing and not something to say in the positive colour.
  function describeRoom() {
    const lost = [...ailing.values()].filter((peer) => peer.lost).map((peer) => peer.name);
    if (lost.length) {
      return setStatus(`Lost the connection to ${nameList(lost)}. Still trying…`, 'bad');
    }

    const shaky = [...ailing.values()].map((peer) => peer.name);
    if (shaky.length) return setStatus(`Reconnecting to ${nameList(shaky)}…`, 'warn');

    if (Tiles.count()) return setStatus('Connected.', 'ok');
    setStatus('Waiting for someone to join.', 'ok');
  }

  function nameList(names) {
    if (names.length < 3) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  function setStatus(message, tone) {
    statusEl.textContent = message;
    statusEl.className = `status ${tone}`;
  }
})();
