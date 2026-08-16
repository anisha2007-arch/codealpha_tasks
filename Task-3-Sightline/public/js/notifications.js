// The header's unread badge and the panel behind it. Rows are written by the
// server when somebody gives you a task or adds you to a project; new ones
// arrive over the same WebSocket the board uses, addressed to the person
// rather than the board.
const Notifications = (() => {
  let host = null;
  let badge = null;
  let panel = null;
  let button = null;
  let items = [];
  let unread = 0;

  document.addEventListener('chrome:ready', (event) => {
    if (event.detail.user) mount();
  });

  function mount() {
    host = document.querySelector('[data-notifications]');
    if (!host) return;

    host.innerHTML = `
      <div class="notif">
        <button class="notif-button" type="button" aria-expanded="false">
          Alerts<span class="notif-badge" hidden>0</span>
        </button>
        <div class="notif-panel" hidden></div>
      </div>`;

    button = host.querySelector('.notif-button');
    badge = host.querySelector('.notif-badge');
    panel = host.querySelector('.notif-panel');

    button.addEventListener('click', toggle);
    panel.addEventListener('click', follow);
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) closePanel();
    });

    // Only the board page keeps a socket open, so elsewhere the badge is
    // whatever it was when the page loaded. That is the honest limit of a
    // header on a page with no live connection.
    //
    // `typeof` rather than `window.Live`: every module here is a top-level
    // `const` in a classic script, which is a lexical binding and never a
    // property of the global object, so `window.Live` is undefined even on the
    // board where live.js is loaded. `typeof` is also the only form that does
    // not throw on the pages that omit live.js.
    if (typeof Live !== 'undefined') {
      Live.on('notification.added', receive);
      // Another tab of ours opened the panel. No toast: nothing arrived, and
      // the person is looking at the tab where it happened, not this one.
      Live.on('notification.read', markReadLocally);
    }

    load();
  }

  async function load() {
    try {
      const data = await Api.get('/notifications');
      items = data.items;
      setUnread(data.unread);
      renderPanel();
    } catch {
      // A header that cannot fetch its alerts is not worth interrupting the
      // page for; the badge simply stays at zero.
    }
  }

  function receive(event) {
    items = [event.notification, ...items].slice(0, 30);
    setUnread(event.unread);
    renderPanel();
    Chrome.toast(event.notification.body);
  }

  // Crosses off exactly what the server says was read, so a panel opened on a
  // subset does not grey out the rest here.
  function markReadLocally({ ids, unread: left }) {
    const read = new Set(Array.isArray(ids) ? ids : []);
    const now = new Date().toISOString();
    items = items.map((item) => (read.has(item.id) ? { ...item, readAt: item.readAt || now } : item));
    setUnread(left);
    renderPanel();
  }

  function setUnread(count) {
    unread = count;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = !count;
  }

  function renderPanel() {
    panel.innerHTML = items.length
      ? items.map(rowHTML).join('')
      : '<p class="muted small notif-empty">Nothing yet.</p>';
  }

  function rowHTML(item) {
    return `
      <a class="notif-row${item.readAt ? '' : ' unread'}"
         href="${item.projectId ? `/board.html?project=${item.projectId}` : '#'}">
        <span>${Html.escape(item.body)}</span>
        <span class="muted small">${Format.timeAgo(item.createdAt)}</span>
      </a>`;
  }

  async function toggle() {
    if (!panel.hidden) return closePanel();

    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    await load();

    if (!unread) return;
    try {
      const { unread: left } = await Api.post('/notifications/read', {});
      items = items.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() }));
      setUnread(left);
      renderPanel();
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function follow(event) {
    if (event.target.closest('a[href="#"]')) event.preventDefault();
  }

  return { load };
})();
