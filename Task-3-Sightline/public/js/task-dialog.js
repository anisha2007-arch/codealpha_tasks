// The task editor. It owns the form and the two things around it — who the
// task can be assigned to and which column it is in — and hands the discussion
// underneath to CommentThread.
const TaskDialog = (() => {
  const dialog = document.getElementById('task-dialog');
  const form = dialog.querySelector('form');
  const section = dialog.querySelector('[data-comment-section]');
  const deleteBtn = dialog.querySelector('[data-delete]');

  let config = {};
  let current = null;

  function init(options) {
    config = options;
    setColumns(options.columns);
    setMembers(options.members);

    CommentThread.init({
      list: dialog.querySelector('[data-comments]'),
      form: dialog.querySelector('[data-comment-form]'),
      onPosted: (task) => config.onChange(task),
    });

    form.addEventListener('submit', save);
    deleteBtn.addEventListener('click', remove);
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => CommentThread.close());
  }

  // The columns come from the server rather than from a hard-coded list in the
  // page, so adding one is a change to server/statuses.js alone.
  function setColumns(columns) {
    config.columns = columns;
    form.elements.status.innerHTML = columns
      .map((column) => `<option value="${Html.escape(column.key)}">${Html.escape(column.label)}</option>`)
      .join('');
  }

  // Rebuilt whenever the roster changes. Building it once in init() is why an
  // invited member stayed missing from "Assigned to" until a full page reload,
  // even though the invite had reported success.
  function setMembers(members) {
    config.members = members;
    const chosen = form.elements.assigneeId.value;
    form.elements.assigneeId.innerHTML =
      '<option value="">Unassigned</option>' +
      members.map((m) => `<option value="${m.id}">${Html.escape(m.name)}</option>`).join('');
    if (chosen && members.some((m) => String(m.id) === chosen)) {
      form.elements.assigneeId.value = chosen;
    }
  }

  // The owner can delete anything on the board; everyone else can delete what
  // they put there. The server enforces this too — this only stops the button
  // offering something that would be refused.
  function mayDelete(task) {
    return config.role === 'owner' || (config.me && task.createdBy === config.me.id);
  }

  function openNew() {
    current = null;
    fill({ title: '', body: '', status: config.columns[0].key, assignee: null });
    deleteBtn.hidden = true;
    section.hidden = true;
    dialog.showModal();
    form.elements.title.focus();
  }

  function open(task) {
    if (!task) return;
    current = task;
    fill(task);
    deleteBtn.hidden = !mayDelete(task);
    section.hidden = false;
    dialog.showModal();
    CommentThread.open(task.id);
  }

  function fill(task) {
    form.elements.title.value = task.title;
    form.elements.body.value = task.body;
    form.elements.status.value = task.status;
    form.elements.assigneeId.value = task.assignee ? task.assignee.id : '';
  }

  async function save(event) {
    event.preventDefault();
    const payload = {
      title: form.elements.title.value.trim(),
      body: form.elements.body.value.trim(),
      status: form.elements.status.value,
      assigneeId: form.elements.assigneeId.value || null,
    };

    try {
      const task = current
        ? await Api.patch(`/tasks/${current.id}`, payload)
        : await Api.post(`/projects/${config.projectId}/tasks`, payload);
      config.onChange(task);
      dialog.close();
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  async function remove() {
    if (!current || !confirm('Delete this task?')) return;
    try {
      await Api.del(`/tasks/${current.id}`);
      config.onRemove(current.id);
      dialog.close();
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  // Closes the dialog if the task it is showing has just been deleted by
  // somebody else.
  function taskRemoved(taskId) {
    if (current && current.id === taskId && dialog.open) dialog.close();
  }

  return { init, open, openNew, setMembers, setColumns, taskRemoved, receiveComment: CommentThread.receive };
})();
