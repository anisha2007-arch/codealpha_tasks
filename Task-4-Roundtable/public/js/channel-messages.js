// What comes over a peer's data channel, and who it belongs to.
//
// Everything in the call that is not audio or video travels this one channel:
// whiteboard strokes, the board handshake a newcomer does, and file transfers.
// That makes it a small protocol rather than page wiring, which is why it is
// here and not in room.js — the set of message kinds is the thing to read in
// one place when adding another.
const ChannelMessages = (() => {
  // Binary frames are always file chunks: they are the only thing big enough
  // to be worth not encoding as JSON, and transfer.js matches them to a
  // transfer by sender.
  function receive(peerId, name, raw) {
    if (raw instanceof ArrayBuffer) return Transfer.receiveChunk(peerId, raw);

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      // Anything that is not JSON is not ours. A peer running a different
      // version of the page should not be able to break this one.
      return;
    }

    if (message.kind === 'stroke') return Whiteboard.receive(message.stroke);
    if (message.kind === 'board-clear') return Whiteboard.clear(false);
    // A newcomer asks for the board as it stands; whoever hears it answers,
    // in batches. BoardSync owns both ends of that exchange.
    if (message.kind === 'board-request') return void BoardSync.reply(peerId);
    if (BoardSync.receive(peerId, message)) return;
    // The whole board in one message, from a peer running the build that sent
    // it that way. Still accepted — it is their message size that was the
    // problem, and receiving one costs a line.
    if (message.kind === 'board-state') return Whiteboard.restore(message.strokes);
    if (message.kind === 'file-start') return Transfer.startReceiving(peerId, message);
    if (message.kind === 'file-end') return Transfer.finishReceiving(peerId, message.id, name);
  }

  return { receive };
})();
