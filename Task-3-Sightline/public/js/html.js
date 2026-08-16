// Escaping, and the markup that depends on it. Pure functions: nothing here
// touches the document or registers a listener, so it can be reasoned about
// and reused anywhere a string of HTML is being built.
const Html = (() => {
  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  // Initials stand in for avatars, so there are no uploads to store or serve.
  function avatar(person, size = '') {
    if (!person) return '';
    const hue = [...String(person.name || '')].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 360;
    return `<span class="avatar ${size}" style="--hue:${hue}" title="${escape(person.name)}">${escape(initials(person.name))}</span>`;
  }

  return { escape, initials, avatar };
})();
