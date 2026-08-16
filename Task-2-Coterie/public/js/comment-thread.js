// The comment thread under a post: opening it, drawing it, composing, and
// deleting. Lifted out of post-card.js, which had grown into a card renderer
// with a whole comment feature buried inside it.
//
// A thread lives in the `.comments` box of one post article. Nothing here
// registers listeners of its own: PostCard delegates from the feed container
// and calls in, so re-rendering a feed cannot leave handlers behind.
const CommentThread = (() => {
  function box(article) {
    return article.querySelector('.comments');
  }

  async function toggle(article, postId) {
    const el = box(article);
    if (!el.hidden) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    el.innerHTML = placeholder('Loading…');
    try {
      const comments = await Api.get(`/posts/${postId}/comments`);
      el.innerHTML = comments.map(commentHTML).join('') + composerHTML();
    } catch (err) {
      el.innerHTML = placeholder(err.message);
    }
  }

  // Placeholders are marked rather than found by class, because every rendered
  // comment carries muted text of its own.
  function placeholder(text) {
    return `<p class="muted" data-placeholder>${Html.escape(text)}</p>`;
  }

  function commentHTML(comment) {
    return `
      <div class="comment" data-comment="${comment.id}">
        ${Html.avatar(comment.author, 'tiny')}
        <div>
          <span class="name">${Html.escape(comment.author.displayName)}</span>
          <span class="handle">${Format.timeAgo(comment.createdAt)}</span>
          <p>${Html.escape(comment.body)}</p>
        </div>
        ${comment.mine ? '<button class="link-btn danger" data-delete-comment>Delete</button>' : ''}
      </div>`;
  }

  function composerHTML() {
    return `
      <form class="comment-form" data-comment-form>
        <input name="body" placeholder="Add a comment" maxlength="400" required />
        <button class="btn small" type="submit">Reply</button>
      </form>`;
  }

  async function add(article, postId, form, onCountChange) {
    const input = form.elements.body;
    const body = input.value.trim();
    if (!body) return;

    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      // The reply carries the author, so the thread does not have to guess at
      // who wrote it from the cached current user.
      const comment = await Api.post(`/posts/${postId}/comments`, { body });
      const empty = box(article).querySelector('[data-placeholder]');
      if (empty) empty.remove();
      form.insertAdjacentHTML('beforebegin', commentHTML(comment));
      input.value = '';
      onCountChange(1);
    } catch (err) {
      Chrome.toast(err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function remove(button, onCountChange) {
    const row = button.closest('[data-comment]');
    try {
      await Api.del(`/comments/${row.dataset.comment}`);
      row.remove();
      onCountChange(-1);
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  return { toggle, add, remove };
})();
