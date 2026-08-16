// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const feedEl` on the same page throw SyntaxError before either runs.
(() => {
  const feedEl = document.getElementById('feed');
  const composer = document.getElementById('composer');
  const scopeBar = document.getElementById('scope');
  const peopleEl = document.getElementById('people');

  let scope = 'home';

  (async () => {
    if (!(await Api.requireUser())) return;

    PostCard.wire(feedEl);
    await fillCircleOptions();
    loadFeed();
    loadPeople();

    scopeBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-scope]');
      if (!button || button.dataset.scope === scope) return;
      scope = button.dataset.scope;
      scopeBar.querySelectorAll('[data-scope]').forEach((b) => {
        b.classList.toggle('active', b.dataset.scope === scope);
      });
      loadFeed();
    });

    composer.addEventListener('submit', createPost);
  })();

  async function fillCircleOptions() {
    const select = composer.elements.circle;
    try {
      const circles = await Api.get('/circles');
      select.insertAdjacentHTML('beforeend', circles
        .map((c) => `<option value="${c.slug}">${Html.escape(c.name)}</option>`)
        .join(''));
    } catch {
      // The composer still works without a circle attached.
    }
  }

  async function loadFeed() {
    feedEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const posts = await Api.get(`/posts?scope=${scope}`);
      feedEl.innerHTML = posts.length
        ? posts.map(PostCard.html).join('')
        : emptyMessage();
    } catch (err) {
      feedEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }

  function emptyMessage() {
    return scope === 'home'
      ? `<div class="empty">
           <h2>Quiet in here</h2>
           <p>Write the first post, or switch to Everyone to find people to follow.</p>
         </div>`
      : `<div class="empty"><h2>Nothing posted yet</h2><p>Be the first.</p></div>`;
  }

  async function createPost(event) {
    event.preventDefault();
    const body = composer.elements.body.value.trim();
    if (!body) return;

    const button = composer.querySelector('button[type=submit]');
    button.disabled = true;

    try {
      const post = await Api.post('/posts', { body, circle: composer.elements.circle.value });
      const empty = feedEl.querySelector('.empty, .muted');
      if (empty) feedEl.innerHTML = '';
      feedEl.insertAdjacentHTML('afterbegin', PostCard.html(post));
      composer.elements.body.value = '';
    } catch (err) {
      Chrome.toast(err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function loadPeople() {
    try {
      const people = (await Api.get('/users')).filter((p) => !p.following).slice(0, 6);
      peopleEl.innerHTML = people.length
        ? people.map(personHTML).join('')
        : '<p class="muted small">Nobody new to follow yet.</p>';
    } catch {
      peopleEl.innerHTML = '';
    }

    peopleEl.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-follow]');
      if (!button) return;
      button.disabled = true;
      try {
        const result = await Api.post(`/users/${button.dataset.follow}/follow`);
        button.textContent = result.following ? 'Following' : 'Follow';
        button.classList.toggle('on', result.following);
        if (result.following) loadFeed();
      } catch (err) {
        Chrome.toast(err.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  function personHTML(person) {
    return `
      <div class="person">
        ${Html.avatar(person, 'tiny')}
        <a href="/profile.html?handle=${encodeURIComponent(person.handle)}">${Html.escape(person.displayName)}</a>
        <button class="chip-btn" data-follow="${Html.escape(person.handle)}">Follow</button>
      </div>`;
  }
})();
