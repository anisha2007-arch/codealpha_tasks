// A full mesh: every browser holds one RTCPeerConnection per other person in
// the room. Fine for a small meeting, which is why the server caps the room
// size; a larger call would need a selective forwarding unit instead.
const Peers = (() => {
  const connections = new Map();
  let config = {};

  function init(options) {
    config = options;
    // Recovery needs to re-offer, which is negotiation.
    PeerRecovery.init({
      negotiate: PeerNegotiation.negotiate,
      onTrouble: options.onPeerTrouble,
      onLost: options.onPeerLost,
      onRecovered: options.onPeerRecovered,
    });
  }

  function get(peerId) {
    return connections.get(peerId);
  }

  function names() {
    return [...connections].map(([peerId, peer]) => ({ peerId, name: peer.name }));
  }

  function create(peerId, name, initiator) {
    if (connections.has(peerId)) return connections.get(peerId);

    const connection = new RTCPeerConnection({ iceServers: config.iceServers });
    const peer = {
      connection,
      name,
      initiator,
      channel: null,
      pendingCandidates: [],
      recoveryTimer: null,
      attempts: 0,
      // An ICE restart offer is out and we are waiting for the answer. Both
      // sides notice the same outage, so without this the initiator offers
      // once for its own timer and again for the other side's request.
      restarting: false,
      // The retry budget is spent. Reported once, not on every slow retry.
      lost: false,
    };
    connections.set(peerId, peer);

    addLocalTracks(connection);

    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) Signal.send(peerId, { candidate: event.candidate });
    });

    connection.addEventListener('track', (event) => {
      config.onTrack(peerId, peer.name, event.streams[0]);
    });

    PeerRecovery.watch(peerId, peer, { onClosed: () => remove(peerId) });

    if (initiator) {
      attachChannel(peerId, peer, connection.createDataChannel('room', { ordered: true }));
      PeerNegotiation.negotiate(peerId, peer);
    } else {
      connection.addEventListener('datachannel', (event) => {
        attachChannel(peerId, peer, event.channel);
      });
    }

    return peer;
  }

  // Audio comes from the microphone; video is whatever is being sent right
  // now, which is the shared screen while a share is running. Adding
  // localStream's video track unconditionally is why somebody who joined
  // mid-share was sent the camera and had no way back to the screen.
  function addLocalTracks(connection) {
    const stream = config.localStream;
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);

    const video = config.outboundVideoTrack();
    if (video) connection.addTrack(video, stream);
  }

  function attachChannel(peerId, peer, channel) {
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => config.onChannelOpen(peerId));
    channel.addEventListener('message', (event) => config.onData(peerId, peer.name, event.data));

    // A channel does not fail where you sent from. An oversized message, or
    // anything else the transport refuses, returns from send() as if it
    // worked and turns up here a moment later — after which the browser
    // closes the channel and every stroke and file on it stops, in both
    // directions, with the call still looking healthy. Nobody was listening
    // for this, which is what made that silent.
    channel.addEventListener('error', (event) => {
      const detail = event.error ? event.error.message || String(event.error) : 'unknown error';
      console.warn(`Data channel to ${peer.name} failed:`, detail);
      config.onChannelError?.(peerId, peer.name, detail);
    });
  }

  // Who a signal is for, and whether it may bring a connection into being.
  // What to do with it once there is a peer to do it to is PeerNegotiation's.
  async function handleSignal(peerId, name, data) {
    let peer = connections.get(peerId);
    if (!peer) {
      // Only an offer may bring a connection into being. A candidate that
      // straggles in after somebody has left used to create a bare connection
      // that never negotiated and was never cleaned up.
      if (!data.description || data.description.type !== 'offer') return;
      peer = create(peerId, name, false);
    }

    await PeerNegotiation.apply(peerId, peer, data);
  }

  // The roster entry and the tile go whether or not there was a connection to
  // close. Returning early when there was none is what left four copies of
  // somebody who had already left sitting in the list.
  function remove(peerId) {
    const peer = connections.get(peerId);
    if (peer) {
      PeerRecovery.stop(peer);
      peer.connection.close();
      connections.delete(peerId);
    }
    config.onPeerLeft(peerId);
  }

  // Everything goes: used when the signalling server gives us a new identity
  // after a reconnect, at which point every peer id we are holding is stale
  // and every connection to them has already been closed from their side.
  function reset() {
    for (const peerId of [...connections.keys()]) remove(peerId);
  }

  // Used when switching between the camera and a shared screen.
  async function replaceVideoTrack(track) {
    for (const peer of connections.values()) {
      const sender = peer.connection.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }
  }

  function broadcast(message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    for (const peer of connections.values()) {
      if (peer.channel && peer.channel.readyState === 'open') peer.channel.send(payload);
    }
  }

  function channelFor(peerId) {
    const peer = connections.get(peerId);
    return peer && peer.channel && peer.channel.readyState === 'open' ? peer.channel : null;
  }

  function openChannelIds() {
    return [...connections.keys()].filter((peerId) => channelFor(peerId));
  }

  function openChannels() {
    return openChannelIds().map(channelFor);
  }

  return {
    init, create, handleSignal, remove, reset, replaceVideoTrack,
    broadcast, channelFor, openChannels, openChannelIds, get, names,
  };
})();
