// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const headerEl` on the same page throw SyntaxError before either runs.
(() => {
  const listEl = document.getElementById('circles');

  (async () => {
    if (!(await Api.requireUser())) return;
    load();

    listEl.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-join]');
      if (!button) return;
      button.disabled = true;
      try {
        const result = await Api.post(`/circles/${button.dataset.join}/join`);
        button.textContent = result.joined ? 'Joined' : 'Join';
        button.classList.toggle('on', result.joined);
        button.closest('.circle-card').querySelector('[data-members]').textContent = result.memberCount;
      } catch (err) {
        Chrome.toast(err.message);
      } finally {
        button.disabled = false;
      }
    });
  })();

  async function load() {
    listEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const circles = await Api.get('/circles');
      listEl.innerHTML = circles.map(cardHTML).join('');
    } catch (err) {
      listEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }

  function cardHTML(circle) {
    const href = `/circle.html?slug=${encodeURIComponent(circle.slug)}`;
    return `
      <article class="circle-card">
        <a class="circle-name" href="${href}">${Html.escape(circle.name)}</a>
        <p>${Html.escape(circle.description)}</p>
        <div class="circle-foot">
          <span class="muted small">
            <span data-members>${circle.memberCount}</span> members · ${circle.postCount} posts
          </span>
          <button class="chip-btn ${circle.joined ? 'on' : ''}" data-join="${Html.escape(circle.slug)}">
            ${circle.joined ? 'Joined' : 'Join'}
          </button>
        </div>
      </article>`;
  }
})();
