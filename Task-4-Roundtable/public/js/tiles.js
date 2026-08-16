// The video grid and the list of who is in the room.
const Tiles = (() => {
  const grid = document.getElementById('grid');
  const rosterEl = document.getElementById('roster');
  const countEl = document.getElementById('peer-count');

  // peerId -> { name, self }. `self` means this peer is the same account in
  // another tab: a real peer connection, carrying your own microphone back.
  const peers = new Map();
  let myName = 'You';

  // What to call a peer. Two tabs of one account produce two roster entries
  // with the same name, the same avatar and the same hue, and nothing to tell
  // them apart — so say which one is you.
  function labelFor(name, self) {
    return self ? `${name} (your other tab)` : name;
  }

  function setLocal(stream, name) {
    myName = name;
    const tile = build('local', `${name} (you)`);
    const video = tile.querySelector('video');
    video.srcObject = stream;
    video.muted = true;
    grid.prepend(tile);
    refreshRoster();
  }

  function add(peerId, name, stream) {
    const known = peers.get(peerId);
    const self = known ? known.self : false;

    const existing = document.getElementById(`tile-${peerId}`);
    if (existing) {
      existing.querySelector('video').srcObject = stream;
      return;
    }
    const tile = build(peerId, labelFor(name, self));
    const video = tile.querySelector('video');
    video.srcObject = stream;
    // Your own voice, arriving over a genuine peer connection from your other
    // tab. Only the local tile used to be muted, so on a machine with
    // speakers this was an immediate feedback loop — reachable by clicking
    // the room link twice.
    video.muted = self;
    grid.append(tile);
    peers.set(peerId, { name, self });
    refreshRoster();
  }

  function remove(peerId) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) tile.remove();
    peers.delete(peerId);
    refreshRoster();
  }

  // Everything except the local tile. Used after a reconnect, when the server
  // has given this browser a new identity and every peer id on screen is stale.
  function reset() {
    for (const peerId of [...peers.keys()]) {
      const tile = document.getElementById(`tile-${peerId}`);
      if (tile) tile.remove();
    }
    peers.clear();
    refreshRoster();
  }

  function nameOf(peerId) {
    return peers.get(peerId)?.name || null;
  }

  function build(id, label) {
    const tile = document.createElement('figure');
    tile.className = 'tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <figcaption>${Html.escape(label)}</figcaption>`;
    return tile;
  }

  // The roster entry, which arrives from the signalling server before any
  // media does. `self` comes from the server, which is the only side that
  // knows which account is behind a peer id.
  function note(peerId, name, self = false) {
    peers.set(peerId, { name, self });

    // A tile may already be on screen from an earlier note() that did not
    // know, or from a track that arrived first.
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      tile.querySelector('figcaption').textContent = labelFor(name, self);
      tile.querySelector('video').muted = self;
    }
    refreshRoster();
  }

  function refreshRoster() {
    const everyone = [
      { name: myName, self: false, you: true },
      ...[...peers.values()].map(({ name, self }) => ({ name, self, you: false })),
    ];
    countEl.textContent = everyone.length;
    rosterEl.innerHTML = everyone
      .map(({ name, self, you }) => {
        const label = you ? name : labelFor(name, self);
        return `<li>${Html.avatar({ name }, 'tiny')} ${Html.escape(label)}</li>`;
      })
      .join('');
  }

  return { setLocal, add, remove, note, reset, nameOf, count: () => peers.size };
})();
