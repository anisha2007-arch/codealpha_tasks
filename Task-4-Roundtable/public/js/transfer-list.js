// The list of file transfers under the call: one row per file, in or out,
// updated as it goes. This is to transfer.js what tiles.js is to peers.js —
// the presentation layer, so the module that moves the bytes has no opinion
// about how a row looks.
const TransferList = (() => {
  const filesEl = document.getElementById('files');

  // One row per transfer, created on first sight and reused after that, so
  // progress updates in place rather than stacking up a row per chunk.
  function rowFor(direction, id) {
    const rowId = `transfer-${direction}-${id}`;
    let row = document.getElementById(rowId);
    if (!row) {
      row = document.createElement('div');
      row.className = 'transfer';
      row.id = rowId;
      filesEl.prepend(row);
    }
    return row;
  }

  function showProgress({ direction, id, name, sent, size }) {
    const percent = Math.round((sent / size) * 100);
    rowFor(direction, id).innerHTML = `
      <span>${direction === 'out' ? 'Sending' : 'Receiving'} ${Html.escape(name)}</span>
      <progress max="100" value="${percent}"></progress>`;
  }

  function showComplete({ direction, id, name, size, from, url }) {
    const label = direction === 'out'
      ? `Sent ${Html.escape(name)}`
      : `${Html.escape(from || 'Someone')} sent ${Html.escape(name)}`;
    const action = url
      ? `<a download="${Html.escape(name)}" href="${url}">Save (${Math.round(size / 1024)} KB)</a>`
      : `<span class="muted small">${Math.round(size / 1024)} KB</span>`;

    rowFor(direction, id).innerHTML = `<span>${label}</span>${action}`;
  }

  function showFailed({ direction, id, name, reason }) {
    rowFor(direction, id).innerHTML = `
      <span>${direction === 'out' ? 'Sending' : 'Receiving'} ${Html.escape(name)}</span>
      <span class="muted small">${Html.escape(reason)}</span>`;
  }

  return { showProgress, showComplete, showFailed };
})();
