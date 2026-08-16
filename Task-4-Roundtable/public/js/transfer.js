// Files go peer to peer over the data channels, in chunks. Nothing is uploaded
// to the server, so a transfer is limited by the browsers, not by disk space
// on the host.
const Transfer = (() => {
  // Chunk size and backpressure are channel rules rather than file rules, and
  // the whiteboard replay has to obey the same ones, so they live in
  // ChannelFlow.
  const CHUNK_SIZE = ChannelFlow.CHUNK_SIZE;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;

  const incoming = new Map();
  let sending = false;
  let onProgress = () => {};
  let onComplete = () => {};
  let onFailed = () => {};

  function init(handlers) {
    onProgress = handlers.onProgress;
    onComplete = handlers.onComplete;
    onFailed = handlers.onFailed || onFailed;
  }

  function nextId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function busy() {
    return sending;
  }

  // Binary frames carry no id of their own, so the receiver can only match a
  // chunk to "the open transfer from that peer". One send at a time keeps that
  // true. Without it, picking a second file mid-send appended its chunks to
  // the first, and the receiver silently got a corrupt file A and an empty
  // file B.
  async function send(file) {
    if (sending) throw new Error('One file at a time — wait for the current send to finish.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Files are limited to 100 MB.');

    // Recipients are looked up by peer id and re-checked on every chunk, so
    // somebody closing their tab at 60% costs only their own copy.
    let targets = Peers.openChannelIds();
    if (!targets.length) throw new Error('Nobody else is here to receive it.');

    sending = true;
    const id = nextId();
    const meta = { kind: 'file-start', id, name: file.name, size: file.size, mime: file.type };

    try {
      targets = deliver(targets, (channel) => channel.send(JSON.stringify(meta)));

      let sent = 0;
      const reader = file.stream().getReader();

      while (targets.length) {
        const { value, done } = await reader.read();
        if (done) break;

        for (let offset = 0; offset < value.byteLength; offset += CHUNK_SIZE) {
          const chunk = value.slice(offset, offset + CHUNK_SIZE);
          targets = await deliverChunk(targets, chunk);
          if (!targets.length) break;

          sent += chunk.byteLength;
          onProgress({ direction: 'out', id, name: file.name, sent, size: file.size });
        }
      }

      if (!targets.length) {
        onFailed({ direction: 'out', id, name: file.name, reason: 'Everyone left before it finished.' });
        return;
      }

      deliver(targets, (channel) => channel.send(JSON.stringify({ kind: 'file-end', id })));
      onComplete({ direction: 'out', id, name: file.name, size: file.size });
    } finally {
      sending = false;
    }
  }

  // Sends to each peer that still has an open channel and returns the ones
  // that took it. A channel that has closed since the transfer started throws
  // InvalidStateError; that used to reject the whole send and leave everybody
  // else with a truncated file and no file-end.
  function deliver(peerIds, write) {
    const survivors = [];
    for (const peerId of peerIds) {
      const channel = Peers.channelFor(peerId);
      if (!channel) continue;
      try {
        write(channel);
        survivors.push(peerId);
      } catch {
        // They are gone. Everyone else carries on.
      }
    }
    return survivors;
  }

  async function deliverChunk(peerIds, chunk) {
    const survivors = [];
    for (const peerId of peerIds) {
      const channel = Peers.channelFor(peerId);
      if (!channel) continue;
      try {
        await ChannelFlow.drain(channel);
        if (channel.readyState !== 'open') continue;
        channel.send(chunk);
        survivors.push(peerId);
      } catch {
        // Same: drop this recipient, keep the rest.
      }
    }
    return survivors;
  }

  function startReceiving(peerId, meta) {
    incoming.set(`${peerId}:${meta.id}`, { ...meta, chunks: [], received: 0, peerId });
  }

  // Binary messages belong to whichever transfer from that peer is still open.
  // Senders only run one at a time, which is what makes that unambiguous.
  function receiveChunk(peerId, buffer) {
    const entry = [...incoming.entries()].find(([key]) => key.startsWith(`${peerId}:`));
    if (!entry) return;

    const [, transfer] = entry;
    transfer.chunks.push(buffer);
    transfer.received += buffer.byteLength;
    onProgress({
      direction: 'in',
      id: transfer.id,
      name: transfer.name,
      sent: transfer.received,
      size: transfer.size,
    });
  }

  function finishReceiving(peerId, id, senderName) {
    const key = `${peerId}:${id}`;
    const transfer = incoming.get(key);
    if (!transfer) return;
    incoming.delete(key);

    const blob = new Blob(transfer.chunks, { type: transfer.mime || 'application/octet-stream' });
    onComplete({
      direction: 'in',
      id,
      name: transfer.name,
      size: blob.size,
      from: senderName,
      url: URL.createObjectURL(blob),
    });
  }

  // Somebody left. Anything half-received from them will never be completed,
  // so say so and let the chunks go rather than holding a partial file in
  // memory for the rest of the call.
  function forget(peerId, name) {
    for (const [key, transfer] of incoming) {
      if (!key.startsWith(`${peerId}:`)) continue;
      incoming.delete(key);
      onFailed({
        direction: 'in',
        id: transfer.id,
        name: transfer.name,
        reason: `${name || 'They'} left before the file finished.`,
      });
    }
  }

  return { init, send, busy, startReceiving, receiveChunk, finishReceiving, forget, MAX_FILE_BYTES };
})();
