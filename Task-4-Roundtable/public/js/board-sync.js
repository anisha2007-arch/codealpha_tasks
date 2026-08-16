// Catching a newcomer up on the whiteboard.
//
// This used to be one line: reply to a board-request with a single
// JSON.stringify of the whole history. A stroke costs about 160 bytes, so at
// roughly 1,600 strokes — under half a minute of continuous drawing — that
// message crossed the data channel's 256 KB limit and killed the channel for
// good. The newcomer got a blank board, no strokes ever again, and no file
// transfer in either direction, all while the page said "Connected."
//
// So the reply is a small protocol instead: a header saying how many strokes
// are coming, then batches under the message limit, then an end marker. The
// receiver holds them until the end marker and hands the whole thing to the
// whiteboard once, which keeps restore()'s one-repaint behaviour intact.
const BoardSync = (() => {
  // A replay is bulk traffic and live strokes are not. Draining at 64 KB
  // rather than the default half a megabyte keeps the queue ahead of a live
  // stroke short, so drawing during somebody's replay still feels immediate.
  const REPLAY_CEILING = 64 * 1024;

  // Partial replays, by peer id. A peer sends one at a time, so the id in the
  // header only has to distinguish this replay from a stale one that was cut
  // off — not from a second one running alongside it.
  const incoming = new Map();

  let counter = 0;

  function nextId() {
    counter += 1;
    return `b${counter}`;
  }

  // Answers a newcomer's board-request. Returns when the last batch has been
  // handed to the channel, or as soon as the channel goes away.
  async function reply(peerId) {
    const strokes = Whiteboard.snapshot();
    const id = nextId();

    let channel = Peers.channelFor(peerId);
    if (!channel) return;

    const batches = ChannelFlow.group(strokes);

    try {
      channel.send(JSON.stringify({ kind: 'board-begin', id, count: strokes.length }));

      for (const batch of batches) {
        await ChannelFlow.drain(channel, REPLAY_CEILING);
        // Re-checked every batch: a replay of a busy board takes several
        // trips through the event loop, and the newcomer may leave during it.
        channel = Peers.channelFor(peerId);
        if (!channel) return;
        channel.send(JSON.stringify({ kind: 'board-chunk', id, strokes: batch }));
      }

      channel.send(JSON.stringify({ kind: 'board-end', id }));
    } catch {
      // They are gone, or the channel died under us. Their board stays empty
      // until they ask again; nothing here is worth breaking the call over.
    }
  }

  // The receiving half. Returns true if the message was one of ours, so the
  // caller can keep its dispatch flat.
  function receive(peerId, message) {
    if (message.kind === 'board-begin') {
      incoming.set(peerId, { id: message.id, expected: message.count, strokes: [] });
      return true;
    }

    if (message.kind === 'board-chunk') {
      const entry = incoming.get(peerId);
      // A chunk with no header, or one left over from a replay that was
      // superseded, belongs to nothing.
      if (!entry || entry.id !== message.id) return true;
      if (Array.isArray(message.strokes)) entry.strokes.push(...message.strokes);
      return true;
    }

    if (message.kind === 'board-end') {
      const entry = incoming.get(peerId);
      if (!entry || entry.id !== message.id) return true;
      incoming.delete(peerId);
      // Painted in one go, so a big replay is one repaint rather than one per
      // batch, and so a half-delivered replay paints nothing at all.
      Whiteboard.restore(entry.strokes);
      return true;
    }

    return false;
  }

  // Somebody left mid-replay. What arrived is an arbitrary prefix of their
  // board, and no end marker is coming, so it goes.
  function forget(peerId) {
    incoming.delete(peerId);
  }

  // For the tests: how much is being held for a peer that has not finished.
  function pending(peerId) {
    return incoming.get(peerId)?.strokes.length ?? 0;
  }

  return { reply, receive, forget, pending, REPLAY_CEILING };
})();
