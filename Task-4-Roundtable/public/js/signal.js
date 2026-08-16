// Thin wrapper over the signalling socket. It carries offers, answers, and ICE
// candidates only: media and files travel directly between browsers.
const Signal = (() => {
  const handlers = new Map();
  let socket = null;
  let slug = null;
  let retryDelay = 1000;

  function connect(roomSlug) {
    slug = roomSlug;
    open();
  }

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/signal?room=${encodeURIComponent(slug)}`);

    socket.addEventListener('open', () => { retryDelay = 1000; emit('open', {}); });
    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      emit(payload.type, payload);
    });

    socket.addEventListener('close', (event) => {
      emit('closed', event);
      // 4001 (not signed in, or no such room), 4002 (room full) and 4003 (too
      // many tabs of this account) are refusals from the server; retrying will
      // not help.
      if (event.code === 4001 || event.code === 4002 || event.code === 4003) return;
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    });
  }

  function emit(type, payload) {
    (handlers.get(type) || []).forEach((fn) => fn(payload));
  }

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  }

  function send(to, data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'signal', to, data }));
    }
  }

  return { connect, on, send };
})();
