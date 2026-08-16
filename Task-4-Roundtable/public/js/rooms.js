// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const listEl` on the same page throw SyntaxError before either runs.
(() => {
  const listEl = document.getElementById('rooms');
  const createForm = document.getElementById('new-room');
  const joinForm = document.getElementById('join-room');

  (async () => {
    if (!(await Api.requireUser())) return;
    load();

    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = createForm.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const room = await Api.post('/rooms', { name: new FormData(createForm).get('name') });
        window.location.href = `/room.html?room=${encodeURIComponent(room.slug)}`;
      } catch (err) {
        Chrome.toast(err.message);
        button.disabled = false;
      }
    });

    joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = new FormData(joinForm).get('link').trim();
      const slug = value.includes('room=') ? new URL(value, location.origin).searchParams.get('room') : value;
      if (slug) window.location.href = `/room.html?room=${encodeURIComponent(slug)}`;
    });
  })();

  async function load() {
    listEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rooms = await Api.get('/rooms');
      listEl.innerHTML = rooms.length
        ? rooms.map(cardHTML).join('')
        : `<div class="empty">
             <h2>No rooms yet</h2>
             <p>Start one on the right, then send the link to whoever should join.</p>
           </div>`;
    } catch (err) {
      listEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }

  function cardHTML(room) {
    const when = room.lastVisit
      ? `Last joined ${Format.timeAgo(room.lastVisit)}`
      : `Created ${Format.timeAgo(room.createdAt)}`;
    return `
      <a class="room-card" href="/room.html?room=${encodeURIComponent(room.slug)}">
        <div class="room-top">
          <h2>${Html.escape(room.name)}</h2>
          ${room.mine ? '<span class="tag">Yours</span>' : ''}
        </div>
        <span class="muted small">${when}</span>
      </a>`;
  }
})();
