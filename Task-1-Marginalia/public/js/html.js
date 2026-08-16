// Escaping, and the markup that depends on it. Pure functions: nothing here
// touches the document or registers a listener, so it can be reasoned about
// and reused anywhere a string of HTML is being built. cover() is the one
// place that returns markup carrying behaviour, and it is an inline onerror
// attribute rather than a listener for that reason: the string stays the whole
// of the output.
const Html = (() => {
  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // The cover shown when there is no image to show: a gradient keyed off the
  // slug, so the same book is always the same colour.
  function generatedCover(book, extraClass) {
    const hue = [...book.slug].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 360;
    return `
      <div class="cover ${extraClass}" style="--cover-hue:${hue}">
        <span class="cover-title">${escape(book.title)}</span>
        <span class="cover-author">${escape(book.author)}</span>
      </div>`;
  }

  // A real cover if the book has one, otherwise a generated one, so the
  // catalogue never shows a broken image or an empty box.
  //
  // Having a coverImage is not the same as it loading: Open Library serves a
  // 404 for any ISBN it has no cover for, and that used to render as the
  // browser's broken-image icon next to the alt text. So the generated cover
  // travels with the image and onerror puts it in place. Replacing the img
  // rather than re-pointing its src is also what makes this safe to do inline:
  // what goes in has no img in it, so there is no second error to handle and
  // no way to loop.
  function cover(book, extraClass = '') {
    const fallback = generatedCover(book, extraClass);
    if (!book.coverImage) return fallback;

    return `<img class="cover cover-img ${extraClass}"
                 src="${escape(book.coverImage)}"
                 alt="${escape(book.title)} cover"
                 loading="lazy"
                 data-fallback="${escape(fallback)}"
                 onerror="this.outerHTML = this.dataset.fallback">`;
  }

  return { escape, cover };
})();
