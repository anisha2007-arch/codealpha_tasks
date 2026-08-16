// The two limits every data channel send has to respect, and the wait that
// keeps inside them. Both file transfers and the whiteboard replay push more
// bytes down a channel than fit in one message, and they were solving this
// separately — so the rules live here once.
//
// The important one is MAX_MESSAGE_BYTES. Chromium negotiates
// a=max-message-size:262144, and a single send over that is not refused in any
// way the caller can catch: send() returns normally, the failure arrives later
// as an 'error' event, and the browser then closes the channel. Everything on
// it dies with it — strokes, files, in both directions — while the page still
// reads "Connected." So anything of unbounded length is cut into messages well
// under the limit rather than trusting a size check at the boundary.
const ChannelFlow = (() => {
  // What the boundary actually is. Nothing should be sent at this size; it is
  // here as the thing the budget below is derived from.
  const MAX_MESSAGE_BYTES = 262144;

  // What we actually send: the same 16 KB a file chunk uses. Sixteen times
  // under the cliff, which leaves room for a peer whose limit is lower than
  // Chromium's and for the envelope around a payload.
  const CHUNK_SIZE = 16 * 1024;

  // How much may sit unsent in the channel's queue before a sender waits.
  const BUFFER_CEILING = 512 * 1024;

  // Data channels drop messages if the send buffer is allowed to run away, so
  // wait for it to drain before queueing more. A lower ceiling costs a little
  // throughput and buys back latency for anything sharing the channel, which
  // is why the caller gets to choose it.
  function drain(channel, ceiling = BUFFER_CEILING) {
    if (channel.bufferedAmount < ceiling) return Promise.resolve();
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = ceiling / 2;
      channel.addEventListener('bufferedamountlow', resolve, { once: true });
      // A channel that closes mid-wait would otherwise never resolve, and the
      // send loop would hang for the rest of the call.
      channel.addEventListener('close', resolve, { once: true });
    });
  }

  // Groups items so each group serialises to comfortably less than `budget`.
  // Measured rather than assumed: a stroke is about 160 bytes, but that is a
  // property of the coordinates a browser happens to produce, not a guarantee.
  // An item larger than the budget on its own still gets a group, since
  // splitting it is not this function's business — at 16 KB against a 256 KB
  // cliff there is a great deal of room for that to be harmless.
  function group(items, budget = CHUNK_SIZE) {
    const groups = [];
    let current = [];
    let size = 0;

    for (const item of items) {
      const length = JSON.stringify(item).length + 1;
      if (current.length && size + length > budget) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += length;
    }

    if (current.length) groups.push(current);
    return groups;
  }

  return { drain, group, MAX_MESSAGE_BYTES, CHUNK_SIZE, BUFFER_CEILING };
})();
