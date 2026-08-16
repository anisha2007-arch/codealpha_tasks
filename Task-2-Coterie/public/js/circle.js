// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const feedEl` on the same page throw SyntaxError before either runs.
(() => {
  const headerEl = document.getElementById('circle-header');
  const feedEl = document.getElementById('feed');
  const slug = new URLSearchParams(location.search).get('slug');

  (async () => {
    if (!(await Api.requireUser())) return;
    if (!slug) {
      headerEl.innerHTML = '<p class="muted">No circle was requested.</p>';
      return;
    }

    PostCard.wire(feedEl);

    try {
      const circle = await Api.get(`/circles/${encodeURIComponent(slug)}`);
      document.title = `${circle.name} · Coterie`;
      renderHeader(circle);
    } catch (err) {
      headerEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
      return;
    }

    loadPosts();
  })();

  function renderHeader(circle) {
    headerEl.innerHTML = `
      <h1>${Html.escape(circle.name)}</h1>
      <p class="lead">${Html.escape(circle.description)}</p>
      <div class="circle-foot">
        <span class="muted small"><span data-members>${circle.memberCount}</span> members · ${circle.postCount} posts</span>
        <button class="chip-btn ${circle.joined ? 'on' : ''}" id="join">${circle.joined ? 'Joined' : 'Join'}</button>
      </div>`;

    document.getElementById('join').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await Api.post(`/circles/${encodeURIComponent(slug)}/join`);
        button.textContent = result.joined ? 'Joined' : 'Join';
        button.classList.toggle('on', result.joined);
        headerEl.querySelector('[data-members]').textContent = result.memberCount;
      } catch (err) {
        Chrome.toast(err.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function loadPosts() {
    feedEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const posts = await Api.get(`/circles/${encodeURIComponent(slug)}/posts`);
      feedEl.innerHTML = posts.length
        ? posts.map(PostCard.html).join('')
        : '<div class="empty"><h2>Nothing here yet</h2><p>Post to this circle from the feed.</p></div>';
    } catch (err) {
      feedEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }
})();
