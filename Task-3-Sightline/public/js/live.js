// Keeps one WebSocket open per board and hands events to whoever subscribed.
// Reconnects with a widening delay so a server restart does not need a refresh.
const Live = (() => {
  const handlers = new Map();
  const resyncHandlers = [];
  const deniedHandlers = [];
  let socket = null;
  let projectId = null;
  let retryDelay = 1000;
  let statusEl = null;
  let everConnected = false;

  function connect(id) {
    projectId = id;
    open();
  }

  function open() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/live?project=${projectId}`);

    socket.addEventListener('open', async () => {
      retryDelay = 1000;
      if (!everConnected) {
        everConnected = true;
        return setStatus('live', 'Live');
      }

      // Anything that happened while the socket was down was sent to a socket
      // that no longer existed and is gone for good, so the page has to ask
      // for the current state rather than assume it still has it. Without
      // this the indicator went back to green over a board that was quietly
      // out of date, and the next drag would patch a task that no longer
      // existed.
      setStatus('sync', 'Catching up…');
      try {
        for (const handler of resyncHandlers) await handler();
        setStatus('live', 'Live');
      } catch {
        setStatus('off', 'Out of date — reload the page');
      }
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      // The echo of a change this tab made. It already has the server's reply,
      // which is the same state, so applying it again would double-render and
      // announce the change to the person who made it.
      if (payload.actorId && payload.actorId === Api.clientId) return;

      (handlers.get(payload.type) || []).forEach((fn) => fn(payload));
    });

    socket.addEventListener('close', (event) => {
      // 4001 means the server rejected us at the handshake; 4003 means access
      // was taken away while we were connected. Neither is worth retrying,
      // and 4003 needs saying out loud: the board on screen is one this
      // person can no longer see.
      if (event.code === 4001) return setStatus('off', 'Not connected');
      if (event.code === 4003) {
        setStatus('off', 'No longer on this project');
        deniedHandlers.forEach((fn) => fn(event.reason || 'You were removed from this project.'));
        return;
      }
      setStatus('off', 'Reconnecting…');
      setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    });
  }

  function on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  }

  // Called after every reconnect, never on the first connect. Await-ed in
  // order, so the indicator only goes back to green once the page really has
  // caught up.
  function onResync(handler) {
    resyncHandlers.push(handler);
  }

  // Called when the server closes the socket for good because this person is
  // no longer allowed on this board. The page has a board on screen that it
  // must stop showing.
  function onDenied(handler) {
    deniedHandlers.push(handler);
  }

  function setStatus(state, label) {
    if (!statusEl) statusEl = document.getElementById('live-status');
    if (!statusEl) return;
    statusEl.textContent = label;
    statusEl.className = `live-status ${state}`;
  }

  return { connect, on, onResync, onDenied };
})();
