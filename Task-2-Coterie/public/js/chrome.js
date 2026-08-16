// The furniture every page has: the top bar and the toast. Unlike html.js and
// format.js, which are pure, this registers a listener as soon as it loads.
// That difference is why it is its own file: a self-registering
// DOMContentLoaded handler has no business shipping in the same unit as
// escapeHtml.
const Chrome = (() => {
  function toast(message) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('visible'), 2400);
  }

  async function renderHeader() {
    const host = document.querySelector('[data-header]');
    if (!host) return;

    const user = await Api.currentUser();
    host.innerHTML = `
      <header class="topbar">
        <div class="container">
          <a class="wordmark" href="/">Coterie</a>
          <nav>
            ${user ? `
              <a href="/">Feed</a>
              <a href="/circles.html">Circles</a>
              <a href="/profile.html?handle=${encodeURIComponent(user.handle)}">
                ${Html.avatar(user, 'tiny')} ${Html.escape(user.displayName)}
              </a>
              <button class="link-btn" data-logout>Sign out</button>
            ` : '<a href="/login.html">Sign in</a>'}
          </nav>
        </div>
      </header>`;

    const logout = host.querySelector('[data-logout]');
    if (logout) {
      logout.addEventListener('click', async () => {
        await Api.post('/logout');
        Api.setUser(null);
        window.location.href = '/login.html';
      });
    }

    // The header is built after an await, so anything that wants to hang off
    // it waits for this rather than for DOMContentLoaded, which has long since
    // fired.
    document.dispatchEvent(new CustomEvent('chrome:ready', { detail: { user, host } }));
  }

  document.addEventListener('DOMContentLoaded', renderHeader);

  return { toast, renderHeader };
})();
