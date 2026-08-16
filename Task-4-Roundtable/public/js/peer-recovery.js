// Keeping a connection alive once it has been made, which is a different job
// from making one. peers.js builds the mesh and owns the offer/answer/candidate
// exchange; everything here is about a path that has gone quiet and what to do
// about it.
//
// It never removes a peer. Whether somebody is still in the room is the
// signalling server's answer, not something to infer from a failed ICE check.
const PeerRecovery = (() => {
  // A path that has gone quiet is usually a hiccup, not a departure. Removing
  // the connection on the first 'failed' meant a ten second blip took both
  // tiles away for good, because only newcomers offer and so neither side
  // would ever offer again.
  const DISCONNECT_GRACE_MS = 4000;
  const MAX_RECOVERY_ATTEMPTS = 4;

  // Once the quick attempts are spent we slow down, but we do not stop. An
  // outage longer than the budget is still an outage, and both people are
  // still sitting in the room. Giving up here is what removed a peer that had
  // never left, and then reported the room as empty.
  const LONG_RETRY_MS = 15000;

  let hooks = {};

  function init(options) {
    hooks = options;
  }

  // Attaches the two state listeners a new connection needs. onClosed is the
  // one outcome that is genuinely terminal, and it belongs to the caller
  // because tearing a peer down is the caller's business.
  function watch(peerId, peer, { onClosed }) {
    const { connection } = peer;

    connection.addEventListener('iceconnectionstatechange', () => {
      const state = connection.iceConnectionState;
      if (state === 'connected' || state === 'completed') return settled(peerId, peer);
      if (state === 'disconnected') schedule(peerId, peer, DISCONNECT_GRACE_MS);
      if (state === 'failed') schedule(peerId, peer, 0);
    });

    connection.addEventListener('connectionstatechange', () => {
      const state = connection.connectionState;
      if (state === 'connected') return settled(peerId, peer);
      // 'closed' is final; 'failed' is worth a restart before giving up.
      if (state === 'closed') onClosed();
      if (state === 'failed') schedule(peerId, peer, 0);
    });
  }

  function settled(peerId, peer) {
    clearTimeout(peer.recoveryTimer);
    peer.recoveryTimer = null;
    peer.attempts = 0;
    peer.restarting = false;
    peer.lost = false;
    if (hooks.onRecovered) hooks.onRecovered(peerId, peer.name);
  }

  // An ICE restart re-gathers candidates and re-offers over the existing
  // connection, which is what gets a call back after a network change. Only
  // the side that offered originally may re-offer, or the two would collide;
  // the other side asks for one instead.
  function schedule(peerId, peer, delay) {
    if (peer.recoveryTimer) return;

    peer.recoveryTimer = setTimeout(() => {
      peer.recoveryTimer = null;
      const state = peer.connection.iceConnectionState;
      if (state === 'connected' || state === 'completed' || state === 'closed') return;

      // Past the budget: say so once, then keep trying slowly.
      if (peer.attempts >= MAX_RECOVERY_ATTEMPTS) {
        if (!peer.lost) {
          peer.lost = true;
          if (hooks.onLost) hooks.onLost(peerId, peer.name);
        }
        peer.restarting = false;
        attempt(peerId, peer);
        schedule(peerId, peer, LONG_RETRY_MS);
        return;
      }

      peer.attempts += 1;
      if (hooks.onTrouble) hooks.onTrouble(peerId, peer.name, peer.attempts);

      // A fresh attempt supersedes any offer still outstanding from the last
      // one, so it always offers rather than deferring to the flag.
      peer.restarting = false;
      attempt(peerId, peer);

      // Try again, with more room each time, until the cap.
      schedule(peerId, peer, 2000 * peer.attempts);
    }, delay);
  }

  function attempt(peerId, peer) {
    if (peer.initiator) beginRestart(peerId, peer);
    else Signal.send(peerId, { restart: true });
  }

  function beginRestart(peerId, peer) {
    peer.restarting = true;
    peer.connection.restartIce();
    hooks.negotiate(peerId, peer, { iceRestart: true });
  }

  // The other side asking us to restart. Their side and our own timer both
  // react to the same outage, so if an offer is already outstanding this is
  // that same outage arriving twice: answering it would put a second offer on
  // the wire whose answer lands on a connection that is stable again.
  function requestedByPeer(peerId, peer) {
    if (peer.initiator && !peer.restarting) beginRestart(peerId, peer);
  }

  // An answer arrived, so nothing is outstanding any more.
  function answerApplied(peer) {
    peer.restarting = false;
  }

  function stop(peer) {
    clearTimeout(peer.recoveryTimer);
  }

  return { init, watch, requestedByPeer, answerApplied, stop };
})();
