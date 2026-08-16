const Members = (() => {
  const dialog = document.getElementById('members-dialog');
  const listEl = dialog.querySelector('[data-member-list]');
  const form = dialog.querySelector('form');

  let config = {};

  function init(options) {
    config = options;
    render();

    document.getElementById('open-members').addEventListener('click', () => dialog.showModal());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', invite);
    listEl.addEventListener('click', onListClick);

    // Inviting and removing are the owner's. Everyone else gets the list.
    form.hidden = config.role !== 'owner';
  }

  // Called whenever the roster changes, from an invite here or from somebody
  // else's over the live connection.
  function setMembers(members) {
    config.members = members;
    render();
  }

  function render() {
    listEl.innerHTML = config.members.map((member) => `
      <div class="member" data-member="${member.id}">
        ${Html.avatar(member, 'tiny')}
        <div>
          <span class="name">${Html.escape(member.name)}</span>
          <span class="muted small">${Html.escape(member.email)}</span>
        </div>
        ${member.role === 'owner' ? '<span class="tag">Owner</span>' : ''}
        ${config.role === 'owner' && member.role !== 'owner'
          ? '<button class="link-btn danger" type="button" data-remove>Remove</button>'
          : ''}
      </div>`).join('');
  }

  async function onListClick(event) {
    const button = event.target.closest('[data-remove]');
    if (!button) return;

    const row = button.closest('[data-member]');
    const memberId = Number(row.dataset.member);
    const member = config.members.find((m) => m.id === memberId);
    if (!member || !confirm(`Remove ${member.name} from this project?`)) return;

    button.disabled = true;
    try {
      await Api.del(`/projects/${config.projectId}/members/${memberId}`);
      config.onChange(config.members.filter((m) => m.id !== memberId));
      Chrome.toast(`${member.name} was removed.`);
    } catch (err) {
      button.disabled = false;
      Chrome.toast(err.message);
    }
  }

  async function invite(event) {
    event.preventDefault();
    const input = form.elements.email;
    const email = input.value.trim();
    if (!email) return;

    try {
      const member = await Api.post(`/projects/${config.projectId}/members`, { email });
      const next = config.members.some((m) => m.id === member.id)
        ? config.members
        : [...config.members, member];
      // Tells the page, which puts the new person into the task dialog's
      // "Assigned to" list as well as this one. Rendering only here is why an
      // invited member stayed invisible to the assignee dropdown.
      config.onChange(next);
      input.value = '';
      Chrome.toast(`${member.name} was added to the project.`);
    } catch (err) {
      Chrome.toast(err.message);
    }
  }

  return { init, setMembers };
})();
