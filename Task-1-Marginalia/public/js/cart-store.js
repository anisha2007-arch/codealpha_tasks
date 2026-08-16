const CartStore = (() => {
  const KEY = 'marginalia-cart';

  function read() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(raw) ? raw.filter((l) => l && l.id && l.quantity > 0) : [];
    } catch {
      return [];
    }
  }

  function write(lines) {
    localStorage.setItem(KEY, JSON.stringify(lines));
    document.dispatchEvent(new CustomEvent('cart:changed'));
  }

  function add(bookId, quantity = 1) {
    const lines = read();
    const existing = lines.find((l) => l.id === bookId);
    if (existing) existing.quantity += quantity;
    else lines.push({ id: bookId, quantity });
    write(lines);
  }

  function setQuantity(bookId, quantity) {
    const lines = read().map((l) => (l.id === bookId ? { ...l, quantity } : l));
    write(lines.filter((l) => l.quantity > 0));
  }

  function remove(bookId) {
    write(read().filter((l) => l.id !== bookId));
  }

  function clear() {
    write([]);
  }

  function count() {
    return read().reduce((n, l) => n + l.quantity, 0);
  }

  // Joins the stored quantities against the live catalogue so prices and
  // stock are never trusted from localStorage.
  function withBooks(books) {
    return read().flatMap((line) => {
      const book = books.find((b) => b.id === line.id);
      if (!book) return [];
      return [{ ...book, quantity: line.quantity, lineTotal: book.price * line.quantity }];
    });
  }

  return { read, add, setQuantity, remove, clear, count, withBooks };
})();
