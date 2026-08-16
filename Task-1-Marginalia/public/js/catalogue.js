// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const alertEl` on the same page throw SyntaxError before either runs.
(() => {
  const grid = document.getElementById('grid');
  const genreBar = document.getElementById('genres');
  const searchInput = document.getElementById('search');

  let activeGenre = 'All';
  let searchTimer = null;

  (async () => {
    try {
      renderGenres(await Api.get('/books/genres'));
    } catch {
      renderGenres(['All']);
    }
    loadBooks();
  })();

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadBooks, 250);
  });

  function renderGenres(genres) {
    genreBar.innerHTML = genres
      .map((g) => {
        const genre = Html.escape(g);
        return `<button class="chip ${g === activeGenre ? 'active' : ''}" data-genre="${genre}">${genre}</button>`;
      })
      .join('');
    genreBar.querySelectorAll('[data-genre]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeGenre = btn.dataset.genre;
        renderGenres(genres);
        loadBooks();
      });
    });
  }

  async function loadBooks() {
    const params = new URLSearchParams();
    if (activeGenre !== 'All') params.set('genre', activeGenre);
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());

    grid.innerHTML = '<p class="notice">Fetching the shelves…</p>';
    try {
      const books = await Api.get(`/books?${params}`);
      grid.innerHTML = books.length
        ? books.map(cardHTML).join('')
        : '<p class="notice">Nothing matches that search.</p>';
      wireAddButtons();
    } catch (err) {
      grid.innerHTML = `<p class="notice">${Html.escape(err.message)}</p>`;
    }
  }

  function wireAddButtons() {
    grid.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        CartStore.add(Number(btn.dataset.add));
        Chrome.toast(`Added "${btn.dataset.title}" to your basket`);
      });
    });
  }

  function cardHTML(book) {
    const href = `/book.html?slug=${encodeURIComponent(book.slug)}`;
    const soldOut = book.stock === 0;
    return `
      <article class="book-card">
        <a href="${href}">${Html.cover(book)}</a>
        <div class="book-meta">
          <span class="genre">${Html.escape(book.genre)}</span>
          <a class="book-title" href="${href}">${Html.escape(book.title)}</a>
          <span class="book-author">${Html.escape(book.author)}</span>
          <div class="book-foot">
            <span class="price">${Format.money(book.price)}</span>
            <button class="btn small" data-add="${book.id}"
                    data-title="${Html.escape(book.title)}" ${soldOut ? 'disabled' : ''}>
              ${soldOut ? 'Sold out' : 'Add'}
            </button>
          </div>
        </div>
      </article>`;
  }
})();
