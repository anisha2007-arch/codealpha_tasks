// The discussion under a task: loading it, drawing it, posting to it, and
// taking other people's comments off the live connection. Lifted out of
// task-dialog.js, which now only has to open and close it.
const CommentThread = (() => {
  let listEl = null;
  let formEl = null;
  let taskId = null;
  let onPosted = null;

  function init({ list, form, onPosted: posted }) {
    listEl = list;
    formEl = form;
    onPosted = posted;
    formEl.addEventListener('submit', post);
  }

  // Placeholders are marked, rather than found by class. Every comment carries
  // a `muted small` timestamp of its own, so clearing the placeholder with
  // querySelector('.muted') removed the oldest comment's timestamp as soon as
  // there was one comment to remove it from.
  function placeholder(text) {
    return `<p class="muted small" data-placeholder>${Html.escape(text)}</p>`;
  }

  function clearPlaceholder() {
    const el = listEl.querySelector('[data-placeholder]');
    if (el) el.remove();
  }

  function commentHTML(comment) {
    return `
      <div class="comment" data-comment="${comment.id}">
        ${Html.avatar(comment.author, 'tiny')}
        <div>
          <span class="name">${Html.escape(comment.author.name)}</span>
          <span class="muted small">${Format.timeAgo(comment.createdAt)}</span>
          <p>${Html.escape(comment.body)}</p>
        </div>
      </div>`;
  }

  function append(comment) {
    if (listEl.querySelector(`[data-comment="${comment.id}"]`)) return;
    clearPlaceholder();
    listEl.insertAdjacentHTML('beforeend', commentHTML(comment));
    listEl.scrollTop = listEl.scrollHeight;
  }

  async function open(id) {
    taskId = id;
    listEl.innerHTML = placeholder('Loading…');
    try {
      const comments = await Api.get(`/tasks/${id}/comments`);
      if (taskId !== id) return;
      listEl.innerHTML = comments.map(commentHTML).join('') || placeholder('No comments yet.');
    } catch (err) {
      if (taskId !== id) return;
      listEl.innerHTML = placeholder(err.message);
    }
  }

  function close() {
    taskId = null;
    listEl.innerHTML = '';
    formEl.reset();
  }

  async function post(event) {
    event.preventDefault();
    const input = formEl.elements.body;
    const body = input.value.trim();
    if (!body || !taskId) return;

    const button = formEl.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      // The reply carries the task as well as the comment, because the card's
      // comment count is part of the task.
      const { comment, task } = await Api.post(`/tasks/${taskId}/comments`, { body });
      append(comment);
      input.value = '';
      if (onPosted) onPosted(task);
    } catch (err) {
      Chrome.toast(err.message);
    } finally {
      button.disabled = false;
    }
  }

  // Somebody else's comment, off the live connection. Events this tab caused
  // never get here.
  function receive(event) {
    if (taskId === null || event.taskId !== taskId) return;
    append(event.comment);
  }

  return { init, open, close, receive };
})();
