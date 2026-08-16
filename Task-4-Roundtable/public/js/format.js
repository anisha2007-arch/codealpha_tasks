// Turning values into the strings a person reads. Pure functions, no markup.
const Format = (() => {
  function timeAgo(iso) {
    const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  return { timeAgo };
})();
