// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const alertEl` on the same page throw SyntaxError before either runs.
(() => {
  const detail = document.getElementById('detail');

  (async () => {
    const slug = new URLSearchParams(location.search).get('slug');
    if (!slug) {
      detail.innerHTML = '<p class="notice">No book was requested.</p>';
      return;
    }

    try {
      const book = await Api.get(`/books/${encodeURIComponent(slug)}`);
      document.title = `${book.title} · Marginalia`;
      document.getElementById('crumb').textContent = book.title;
      render(book);
    } catch (err) {
      detail.innerHTML = `<p class="notice">${Html.escape(err.message)}</p>`;
    }
  })();

  function render(book) {
    const soldOut = book.stock === 0;
    detail.className = 'book-detail';
    detail.innerHTML = `
      ${Html.cover(book, 'cover-large')}
      <div class="book-detail-info">
        <span class="genre">${Html.escape(book.genre)}</span>
        <h1>${Html.escape(book.title)}</h1>
        <p class="byline">${Html.escape(book.author)}, ${book.year}</p>
        <p class="price large">${Format.money(book.price)}</p>
        <p class="stock ${soldOut ? 'out' : ''}">
          ${soldOut ? 'Out of stock' : `${book.stock} copies on the shelf`}
        </p>
        <p class="blurb">${Html.escape(book.blurb)}</p>
        <dl class="specs">
          <dt>Pages</dt><dd>${book.pages}</dd>
          <dt>First published</dt><dd>${book.year}</dd>
        </dl>
        <div class="buy-row">
          <div class="stepper">
            <button data-step="-1" aria-label="Fewer copies">-</button>
            <span id="qty">1</span>
            <button data-step="1" aria-label="More copies">+</button>
          </div>
          <button class="btn" id="add" ${soldOut ? 'disabled' : ''}>Add to basket</button>
          <a class="btn ghost" href="/cart.html">View basket</a>
        </div>
      </div>`;

    detail.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => step(Number(btn.dataset.step), book.stock));
    });
    document.getElementById('add').addEventListener('click', () => {
      CartStore.add(book.id, quantity());
      Chrome.toast(`Added ${quantity()} × "${book.title}" to your basket`);
    });
  }

  function quantity() {
    return Number(document.getElementById('qty').textContent) || 1;
  }

  function step(delta, max) {
    const el = document.getElementById('qty');
    el.textContent = Math.min(max, Math.max(1, quantity() + delta));
  }
})();
