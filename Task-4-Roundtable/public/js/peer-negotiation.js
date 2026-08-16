// The offer/answer/candidate exchange for one peer.
//
// peers.js owns the mesh: who is in it, what happens when somebody joins or
// leaves, and the data channel hanging off each connection. What SDP to send
// and what to do with the SDP that comes back is a self-contained problem with
// its own rules — glare, rollback, candidates that arrive early — and it is
// most of what there is to get wrong, so it reads better on its own.
//
// Nothing here knows about the connections map. Every function is handed the
// peer it is working on.
const PeerNegotiation = (() => {
  async function negotiate(peerId, peer, options) {
    try {
      const offer = await peer.connection.createOffer(options);
      await peer.connection.setLocalDescription(offer);
      Signal.send(peerId, { description: peer.connection.localDescription });
    } catch (err) {
      console.warn('Could not negotiate with a peer:', err.message);
    }
  }

  // Applies one signal to an existing peer. Candidates can arrive before the
  // remote description is set, so they are held back until there is somewhere
  // to put them.
  async function apply(peerId, peer, data) {
    if (data.restart) {
      // Their side and our own recovery timer both react to the same outage.
      // If we already have a restart offer outstanding this request is that
      // same outage arriving twice, and answering it would put a second offer
      // on the wire whose answer lands on a connection that is stable again.
      PeerRecovery.requestedByPeer(peerId, peer);
      return;
    }

    if (data.description) return applyDescription(peerId, peer, data.description);

    if (data.candidate) {
      const { connection } = peer;
      if (connection.remoteDescription) {
        await connection.addIceCandidate(data.candidate).catch(() => {});
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  }

  async function applyDescription(peerId, peer, description) {
    const { connection } = peer;

    // Both sides re-offering at once is possible during a restart. The side
    // that originally offered keeps its own offer; the other one gives way.
    const collision = description.type === 'offer' && connection.signalingState !== 'stable';
    if (collision) {
      if (peer.initiator) return;
      await connection.setLocalDescription({ type: 'rollback' }).catch(() => {});
    }

    // An answer to an offer that has already been settled or superseded.
    // There is nothing left to apply it to, and applying it anyway is the
    // "Called in wrong state: stable" the page used to throw.
    if (description.type === 'answer' && connection.signalingState === 'stable') {
      PeerRecovery.answerApplied(peer);
      return;
    }

    await connection.setRemoteDescription(description);
    if (description.type === 'answer') PeerRecovery.answerApplied(peer);

    for (const candidate of peer.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate).catch(() => {});
    }

    if (description.type === 'offer') {
      await connection.setLocalDescription(await connection.createAnswer());
      Signal.send(peerId, { description: connection.localDescription });
    }
  }

  return { negotiate, apply };
})();
