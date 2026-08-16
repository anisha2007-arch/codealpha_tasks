// The board page. Wrapped in an IIFE so its names stay its own: page scripts
// are classic scripts sharing one global scope, and a second `const tasks`
// anywhere else on the page would throw before a line of it ran.
(() => {
  const projectId = Number(new URLSearchParams(location.search).get('project'));
  const boardEl = document.getElementById('board');
  const titleEl = document.getElementById('project-name');

  let columns = [];
  let tasks = [];
  let members = [];
  let me = null;
  let role = 'member';

  (async () => {
    me = await Api.requireUser();
    if (!me) return;
    if (!projectId) {
      boardEl.innerHTML = '<p class="muted">No project was requested.</p>';
      return;
    }

    boardEl.innerHTML = '<p class="muted">Loading…</p>';
    let project;
    try {
      // All four of these are inside the try. Two of them used to sit outside
      // it, so a transient 500 left a blank page with working-looking buttons
      // and no message at all.
      [project, columns, members, tasks] = await Promise.all([
        Api.get(`/projects/${projectId}`),
        Api.get('/columns'),
        Api.get(`/projects/${projectId}/members`),
        Api.get(`/projects/${projectId}/tasks`),
      ]);
    } catch (err) {
      boardEl.innerHTML = `<p class="muted">${Html.escape(err.message)}</p>`;
      return;
    }

    role = project.role;
    document.title = `${project.name} · Sightline`;
    titleEl.textContent = project.name;
    document.getElementById('project-description').textContent = project.description;
    render();

    BoardDnd.init({
      boardEl,
      projectId,
      // The board controller owns the task list; the drag code reads it and
      // hands a new one back rather than keeping a second copy.
      tasks: () => tasks,
      setTasks: (next) => { tasks = next; },
      render,
      onOpenTask: (taskId) => TaskDialog.open(tasks.find((t) => t.id === taskId)),
    });
    TaskDialog.init({ projectId, columns, members, me, role, onChange: applyLocal, onRemove: removeLocal });
    Members.init({ projectId, members, me, role, onChange: setMembers });

    Live.connect(projectId);
    Live.onResync(resync);
    Live.on('task.created', ({ task }) => announce(task, 'was added'));
    Live.on('task.updated', ({ task, quiet }) => announce(task, quiet ? null : 'was updated'));
    Live.on('task.removed', ({ taskId, title }) => {
      if (!tasks.some((t) => t.id === taskId)) return;
      removeLocal(taskId);
      TaskDialog.taskRemoved(taskId);
      Chrome.toast(title ? `"${title}" was deleted` : 'A task was deleted');
    });
    Live.on('tasks.reordered', (event) => {
      tasks = event.tasks;
      render();
    });
    Live.on('comment.added', TaskDialog.receiveComment);
    Live.on('member.added', ({ member }) => {
      if (members.some((m) => m.id === member.id)) return;
      setMembers([...members, member]);
      Chrome.toast(`${member.name} joined the project`);
    });
    // The person removed hears this too, and for them the resync it triggers
    // is two API calls that now 404. That rejection used to escape as an
    // uncaught "No such project." page error, which left the board on screen
    // with every card still on it and swallowed the toast as well.
    Live.on('member.removed', async () => {
      try {
        await resync();
        Chrome.toast('The project members changed');
      } catch {
        // Either it was us who was removed, or the project has gone. Both
        // mean the board on screen is one we can no longer read.
        closeBoard('You are no longer on this project.');
      }
    });

    // The socket said so directly, which is the case the resync above cannot
    // see: the server closes it with 4003 when somebody is removed.
    Live.onDenied((reason) => closeBoard(reason));
    Live.on('project.updated', ({ project: updated }) => {
      titleEl.textContent = updated.name;
      document.getElementById('project-description').textContent = updated.description;
    });
    Live.on('project.removed', () => {
      boardEl.innerHTML = '<p class="muted">This project was deleted.</p>';
    });

    document.getElementById('add-task').addEventListener('click', () => TaskDialog.openNew());
  })();

  // Takes the board off the screen, because whatever is on it is no longer
  // ours to look at. Said once: the socket close and the member.removed event
  // both arrive, in either order.
  let closed = false;
  function closeBoard(message) {
    if (closed) return;
    closed = true;
    tasks = [];
    boardEl.innerHTML = `<p class="muted">${Html.escape(message)}</p>`;
    Chrome.toast(message);
  }

  // Called after every reconnect. Events that arrived while the socket was
  // down went nowhere, so the page asks for the current state instead of
  // trusting what it happens to be holding.
  async function resync() {
    const [nextMembers, nextTasks] = await Promise.all([
      Api.get(`/projects/${projectId}/members`),
      Api.get(`/projects/${projectId}/tasks`),
    ]);
    tasks = nextTasks;
    setMembers(nextMembers);
    render();
  }

  // The roster lives here, and both the People dialog and the task dialog's
  // "Assigned to" list are rebuilt from it whenever it changes.
  function setMembers(list) {
    members = list;
    Members.setMembers(members);
    TaskDialog.setMembers(members);
  }

  // Only somebody else's changes get here: this tab's own echoes are dropped
  // by Live, so there is no need to compare before and after to decide whether
  // to say anything.
  function announce(task, verb) {
    applyLocal(task);
    if (verb) Chrome.toast(`"${task.title}" ${verb}`);
  }

  function applyLocal(task) {
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) tasks.push(task);
    else tasks[index] = task;
    render();
  }

  function removeLocal(taskId) {
    tasks = tasks.filter((t) => t.id !== taskId);
    render();
  }

  function render() {
    if (BoardDnd.isDragging()) return;
    boardEl.innerHTML = columns.map(columnHTML).join('');
    boardEl.querySelectorAll('.column').forEach((column) => BoardDnd.wireColumn(column));
    boardEl.querySelectorAll('.card').forEach((card) => BoardDnd.wireCard(card));
  }

  function cardsIn(status) {
    return tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.position - b.position || a.id - b.id);
  }

  function columnHTML(column) {
    const cards = cardsIn(column.key);
    return `
      <section class="column" data-status="${Html.escape(column.key)}">
        <header>
          <h2>${Html.escape(column.label)}</h2>
          <span class="count">${cards.length}</span>
        </header>
        <div class="cards">${cards.map(cardHTML).join('')}</div>
      </section>`;
  }

  function cardHTML(task) {
    return `
      <article class="card" draggable="true" data-task="${task.id}">
        <p class="card-title">${Html.escape(task.title)}</p>
        <div class="card-foot">
          ${task.assignee ? Html.avatar(task.assignee, 'tiny') : '<span class="muted small">Unassigned</span>'}
          ${task.commentCount
            ? `<span class="muted small">${task.commentCount} ${task.commentCount === 1 ? 'comment' : 'comments'}</span>`
            : ''}
        </div>
      </article>`;
  }
})();
