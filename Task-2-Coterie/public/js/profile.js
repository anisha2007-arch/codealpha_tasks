// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const feedEl` on the same page throw SyntaxError before either runs.
(() => {
  const headerEl = document.getElementById('profile-header');
  const feedEl = document.getElementById('feed');
  const handle = new URLSearchParams(location.search).get('handle');

  (async () => {
    const me = await Api.requireUser();
    if (!me) return;
    if (!handle) {
      window.location.replace(`/profile.html?handle=${encodeURIComponent(me.handle)}`);
      return;
    }

    PostCard.wire(feedEl);

    try {
      const profile = await Api.get(`/users/${encodeURIComponent(handle)}`);
      document.title = `${profile.displayName} · Coterie`;
      renderHeader(profile);
    } catch (err) {
      headerEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
      return;
    }

    loadPosts();
  })();

  function renderHeader(profile) {
    const action = profile.isMe
      ? '<button class="chip-btn" id="edit">Edit profile</button>'
      : `<button class="chip-btn ${profile.following ? 'on' : ''}" id="follow">
           ${profile.following ? 'Following' : 'Follow'}
         </button>`;

    headerEl.innerHTML = `
      ${Html.avatar(profile, 'large')}
      <div>
        <h1>${Html.escape(profile.displayName)}</h1>
        <p class="handle">@${Html.escape(profile.handle)}</p>
        ${profile.bio ? `<p class="bio">${Html.escape(profile.bio)}</p>` : ''}
        <p class="counts">
          <strong>${profile.postCount}</strong> posts ·
          <button class="link-btn" data-list="followers">
            <strong data-followers>${profile.followerCount}</strong> followers
          </button> ·
          <button class="link-btn" data-list="following">
            <strong>${profile.followingCount}</strong> following
          </button>
        </p>
        <p class="muted small">Joined ${new Date(profile.joined).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>
        ${action}
      </div>`;

    headerEl.querySelectorAll('[data-list]').forEach((button) => {
      button.addEventListener('click', () => openPeople(button.dataset.list, profile));
    });

    const follow = document.getElementById('follow');
    if (follow) follow.addEventListener('click', () => toggleFollow(follow));

    const edit = document.getElementById('edit');
    if (edit) edit.addEventListener('click', () => openEditor(profile));
  }

  // Followers and following share one dialog; only the title and the endpoint
  // differ.
  async function openPeople(which, profile) {
    const dialog = document.getElementById('people');
    const list = dialog.querySelector('[data-people-list]');
    const who = profile.isMe ? 'You' : profile.displayName;

    dialog.querySelector('[data-people-title]').textContent =
      which === 'followers' ? 'Followers' : 'Following';
    list.innerHTML = '<p class="muted">Loading…</p>';
    dialog.showModal();

    try {
      const people = await Api.get(`/users/${encodeURIComponent(handle)}/${which}`);
      list.innerHTML = people.length
        ? people.map(personHTML).join('')
        : `<p class="muted">${Html.escape(which === 'followers'
            ? `${who} ${profile.isMe ? 'have' : 'has'} no followers yet.`
            : `${who} ${profile.isMe ? 'are' : 'is'} not following anyone yet.`)}</p>`;
    } catch (err) {
      list.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }

  function personHTML(person) {
    return `
      <div class="person">
        ${Html.avatar(person, 'tiny')}
        <a href="/profile.html?handle=${encodeURIComponent(person.handle)}">${Html.escape(person.displayName)}</a>
        <span class="handle">@${Html.escape(person.handle)}</span>
      </div>`;
  }

  async function toggleFollow(button) {
    button.disabled = true;
    try {
      const result = await Api.post(`/users/${encodeURIComponent(handle)}/follow`);
      button.textContent = result.following ? 'Following' : 'Follow';
      button.classList.toggle('on', result.following);
      headerEl.querySelector('[data-followers]').textContent = result.followerCount;
    } catch (err) {
      Chrome.toast(err.message);
    } finally {
      button.disabled = false;
    }
  }

  function openEditor(profile) {
    const dialog = document.getElementById('editor');
    dialog.querySelector('[name=displayName]').value = profile.displayName;
    dialog.querySelector('[name=bio]').value = profile.bio;
    dialog.showModal();

    dialog.querySelector('form').onsubmit = async (event) => {
      if (event.submitter && event.submitter.value === 'cancel') return;
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        const updated = await Api.put('/users/me', {
          displayName: data.get('displayName'),
          bio: data.get('bio'),
        });
        Api.setUser({ ...profile, displayName: updated.displayName, bio: updated.bio });
        dialog.close();
        renderHeader(updated);
        Chrome.toast('Profile updated.');
      } catch (err) {
        Chrome.toast(err.message);
      }
    };
  }

  async function loadPosts() {
    feedEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const posts = await Api.get(`/users/${encodeURIComponent(handle)}/posts`);
      feedEl.innerHTML = posts.length
        ? posts.map(PostCard.html).join('')
        : '<div class="empty"><h2>No posts yet</h2></div>';
    } catch (err) {
      feedEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
    }
  }
})();
