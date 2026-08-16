// Dragging cards around the board: the drag listeners on each card and column,
// the drop preview, and the optimistic reorder with its rollback.
//
// It is its own module because it is the one part of the board that writes
// before it knows the write succeeded, and has to be able to put things back.
// The board controller owns the task list; this asks for it and hands back a
// new one, so there is still one copy of the truth.
const BoardDnd = (() => {
  let config = {};

  // A render while a card is mid-drag would replace the element the browser is
  // dragging, so live events are held until the drag ends and dragend redraws.
  let dragging = false;

  function init(options) {
    config = options;
  }

  function isDragging() {
    return dragging;
  }

  function wireCard(card) {
    card.addEventListener('click', () => {
      config.onOpenTask(Number(card.dataset.task));
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', card.dataset.task);
      event.dataTransfer.effectAllowed = 'move';
      dragging = true;
      // Deferred, or the browser snapshots a card that is already half
      // transparent and drags a ghost of the wrong thing.
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragging = false;
      // The drag moved elements around to preview the drop. Whether it ended
      // in a drop or was cancelled, redraw from the tasks we actually hold.
      config.render();
    });
  }

  // Which card the pointer is above, so the drop lands where it looks like it
  // will. Handled on the column rather than on each card because dragover
  // bubbles: a pointer over a card is a pointer over its column.
  function cardAfter(cardsEl, y) {
    const others = [...cardsEl.querySelectorAll('.card:not(.dragging)')];
    let closest = null;
    let closestOffset = Number.NEGATIVE_INFINITY;

    for (const card of others) {
      const box = card.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset;
        closest = card;
      }
    }
    return closest;
  }

  function wireColumn(column) {
    const cardsEl = column.querySelector('.cards');

    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('over');

      // Reordering inside a column is the whole point of the position field,
      // and it used to be unreachable: the drop handler returned early on
      // every same-column drop.
      const card = config.boardEl.querySelector('.card.dragging');
      if (!card) return;
      const after = cardAfter(cardsEl, event.clientY);
      if (after) cardsEl.insertBefore(card, after);
      else cardsEl.appendChild(card);
    });

    column.addEventListener('dragleave', (event) => {
      if (!column.contains(event.relatedTarget)) column.classList.remove('over');
    });

    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('over');

      const status = column.dataset.status;
      const taskIds = [...cardsEl.querySelectorAll('.card')].map((card) => Number(card.dataset.task));
      const draggedId = Number(event.dataTransfer.getData('text/plain'));
      if (!taskIds.includes(draggedId)) return;

      const tasks = config.tasks();
      const snapshot = tasks.map((task) => ({ ...task }));
      taskIds.forEach((id, index) => {
        const task = tasks.find((t) => t.id === id);
        if (task) {
          task.status = status;
          task.position = index + 1;
        }
      });

      commitOrder(status, taskIds, snapshot);
    });
  }

  // The client says what the order is; the server decides what the numbers
  // are, in one transaction under that column's lock. Sending a position we
  // worked out ourselves is how two people dropping into the same column both
  // wrote the same one.
  async function commitOrder(status, taskIds, snapshot) {
    try {
      config.setTasks(await Api.put(`/projects/${config.projectId}/tasks/order`, { status, taskIds }));
    } catch (err) {
      config.setTasks(snapshot);
      Chrome.toast(err.message);
    }
    config.render();
  }

  return { init, wireCard, wireColumn, isDragging };
})();
