// The furniture every page has: the masthead, the basket badge, and the toast.
// Unlike html.js and format.js, which are pure, this registers listeners as
// soon as it loads. That difference is why it is its own file: a self-
// registering DOMContentLoaded handler has no business shipping in the same
// unit as escapeHtml.
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

  function updateCartBadge() {
    const badge = document.querySelector('[data-cart-count]');
    if (badge) badge.textContent = CartStore.count();
  }

  async function renderHeader() {
    const host = document.querySelector('[data-header]');
    if (!host) return;

    const user = await Api.currentUser();
    const account = user
      ? '<a href="/orders.html">Orders</a><button class="link-btn" data-logout>Sign out</button>'
      : '<a href="/login.html">Sign in</a>';

    host.innerHTML = `
      <header class="masthead">
        <div class="container">
          <a class="wordmark" href="/">Marginalia</a>
          <nav>
            <a href="/">Catalogue</a>
            <a href="/cart.html">Basket <span class="badge" data-cart-count>0</span></a>
            ${account}
          </nav>
        </div>
      </header>`;

    const logout = host.querySelector('[data-logout]');
    if (logout) {
      logout.addEventListener('click', async () => {
        await Api.post('/logout');
        Api.setUser(null);
        // The basket lives in localStorage, which outlives the session and is
        // shared by everyone using this browser. Leaving it behind handed the
        // next person to sign in the previous one's basket.
        CartStore.clear();
        window.location.href = '/';
      });
    }
    updateCartBadge();

    // The header is built after an await, so anything that wants to hang off
    // it waits for this rather than for DOMContentLoaded, which has long since
    // fired.
    document.dispatchEvent(new CustomEvent('chrome:ready', { detail: { user, host } }));
  }

  document.addEventListener('DOMContentLoaded', renderHeader);
  document.addEventListener('cart:changed', updateCartBadge);

  return { toast, renderHeader, updateCartBadge };
})();
