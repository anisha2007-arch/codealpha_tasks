// One post: its markup, its like button, its delete button, and the delegated
// listener that drives them. The comment thread underneath it is
// CommentThread's job.
const PostCard = (() => {
  function html(post) {
    const circle = post.circle
      ? `<a class="circle-tag" href="/circle.html?slug=${encodeURIComponent(post.circle.slug)}">${Html.escape(post.circle.name)}</a>`
      : '';

    return `
      <article class="post" data-post="${post.id}">
        <div class="post-head">
          ${Html.avatar(post.author)}
          <div class="post-who">
            <a class="name" href="/profile.html?handle=${encodeURIComponent(post.author.handle)}">${Html.escape(post.author.displayName)}</a>
            <span class="handle">@${Html.escape(post.author.handle)} · ${Format.timeAgo(post.createdAt)}</span>
          </div>
          ${circle}
          ${post.mine ? '<button class="link-btn danger" data-delete>Delete</button>' : ''}
        </div>
        <p class="post-body">${Html.escape(post.body)}</p>
        <div class="post-actions">
          <button class="chip-btn ${post.liked ? 'on' : ''}" data-like>
            <span data-like-label>${post.liked ? 'Liked' : 'Like'}</span>
            <span data-like-count>${post.likeCount}</span>
          </button>
          <button class="chip-btn" data-comments>
            Comments <span data-comment-count>${post.commentCount}</span>
          </button>
        </div>
        <div class="comments" hidden></div>
      </article>`;
  }

  // One delegated listener per container, so re-rendering a feed does not
  // leave old handlers behind.
  function wire(container, { onRemoved } = {}) {
    container.addEventListener('click', async (event) => {
      const article = event.target.closest('[data-post]');
      if (!article) return;
      const postId = Number(article.dataset.post);

      if (event.target.closest('[data-like]')) return toggleLike(article, postId);
      if (event.target.closest('[data-comments]')) return CommentThread.toggle(article, postId);
      if (event.target.closest('[data-delete]')) return removePost(article, postId, onRemoved);

      const deleteComment = event.target.closest('[data-delete-comment]');
      if (deleteComment) return CommentThread.remove(deleteComment, counter(article));
    });

    container.addEventListener('submit', async (event) => {
      if (!event.target.matches('[data-comment-form]')) return;
      event.preventDefault();
      const article = event.target.closest('[data-post]');
      await CommentThread.add(article, Number(article.dataset.post), event.target, counter(article));
    });
  }

  // The comment count lives on the card, so the thread is handed a way to move
  // it rather than a reference to the card itself.
  function counter(article) {
    return (delta) => bumpCount(article, '[data-comment-count]', delta);
  }

  // Disabled for the round trip, so an impatient double click sends one
  // request rather than two that race each other.
  async function toggleLike(article, postId) {
    const button = article.querySelector('[data-like]');
    button.disabled = true;
    try {
      const result = await Api.post(`/posts/${postId}/like`);
      button.classList.toggle('on', result.liked);
      button.querySelector('[data-like-label]').textContent = result.liked ? 'Liked' : 'Like';
      button.querySelector('[data-like-count]').textContent = result.likeCount;
    } catch (err) {
      Chrome.toast(err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function removePost(article, postId, onRemoved) {
    if (!confirm('Delete this post?')) return;
    try {
      await Api.del(`/posts/${postId}`);
      article.remove();
      if (onRemoved) onRemoved();
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  function bumpCount(article, selector, delta) {
    const el = article.querySelector(selector);
    el.textContent = Math.max(0, Number(el.textContent) + delta);
  }

  return { html, wire };
})();
