// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const alertEl` on the same page throw SyntaxError before either runs.
(() => {
  const basketEl = document.getElementById('basket');
  const alertEl = document.getElementById('alert');

  const ADDRESS_KEY = 'marginalia-address';

  let books = [];
  // The shipping rule lives on the server; this page only displays it, so it is
  // never totalled from a second copy of the numbers that could drift.
  let shipping = null;

  (async () => {
    const [catalogue, rule] = await Promise.allSettled([Api.get('/books'), Api.get('/shipping')]);

    if (catalogue.status === 'fulfilled') books = catalogue.value;
    else showAlert('The catalogue could not be loaded, so prices may be missing.');

    if (rule.status === 'fulfilled') shipping = rule.value;
    else showAlert('Shipping could not be worked out, so the order cannot be totalled. Please reload.');

    render();
  })();

  async function render() {
    const lines = CartStore.withBooks(books);

    if (!lines.length) {
      basketEl.innerHTML = `
        <div class="notice empty">
          <h2>Your basket is empty</h2>
          <p>Browse the catalogue and add something to read.</p>
          <a class="btn" href="/">Back to the catalogue</a>
        </div>`;
      return;
    }

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const fee = shipping ? (subtotal >= shipping.freeOver ? 0 : shipping.fee) : null;
    const total = fee === null ? null : subtotal + fee;
    const user = await Api.currentUser();

    // Whatever was typed before being sent to sign in. A saved name beats the
    // account name: the parcel may not be going to the account holder, and
    // overwriting it could ship to the wrong person.
    const saved = readSavedAddress();
    const name = saved.name || (user ? user.name : '');

    basketEl.innerHTML = `
      <div class="basket-layout">
        <div class="basket-lines">${lines.map(lineHTML).join('')}</div>
        <aside>
          <div class="panel">
            <h2>Summary</h2>
            <div class="row"><span>Subtotal</span><span>${Format.money(subtotal)}</span></div>
            <div class="row"><span>Shipping</span><span>${shippingLabel(fee)}</span></div>
            <div class="row grand"><span>Total</span><span>${total === null ? '—' : Format.money(total)}</span></div>
            ${fee ? `<p class="hint">Spend ${Format.money(shipping.freeOver - subtotal)} more for free shipping.</p>` : ''}
          </div>
          <div class="panel">
            <h2>Delivery</h2>
            ${user ? '' : '<p class="hint">You will be asked to sign in before the order is placed.</p>'}
            <label>Name<input id="f-name" value="${Html.escape(name)}" /></label>
            <label>Address<input id="f-line1" placeholder="Flat, street" value="${Html.escape(saved.line1)}" /></label>
            <label>City<input id="f-city" value="${Html.escape(saved.city)}" /></label>
            <label>Postcode<input id="f-postcode" value="${Html.escape(saved.postcode)}" /></label>
            <button class="btn block" id="place" ${total === null ? 'disabled' : ''}>
              Place order${total === null ? '' : ` · ${Format.money(total)}`}
            </button>
          </div>
        </aside>
      </div>`;

    wireLines();
    document.getElementById('place').addEventListener('click', placeOrder);
  }

  function wireLines() {
    basketEl.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const line = CartStore.read().find((l) => l.id === id);
        CartStore.setQuantity(id, line.quantity + Number(btn.dataset.step));
        render();
      });
    });
    basketEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        CartStore.remove(Number(btn.dataset.remove));
        render();
      });
    });
  }

  function lineHTML(line) {
    return `
      <div class="basket-line">
        ${Html.cover(line, 'cover-small')}
        <div>
          <a class="book-title" href="/book.html?slug=${encodeURIComponent(line.slug)}">${Html.escape(line.title)}</a>
          <span class="book-author">${Html.escape(line.author)}</span>
          <span class="unit">${Format.money(line.price)} each</span>
          <div class="line-controls">
            <div class="stepper">
              <button data-step="-1" data-id="${line.id}" aria-label="Fewer copies">-</button>
              <span>${line.quantity}</span>
              <button data-step="1" data-id="${line.id}" aria-label="More copies">+</button>
            </div>
            <button class="link-btn" data-remove="${line.id}">Remove</button>
          </div>
        </div>
        <span class="line-total">${Format.money(line.lineTotal)}</span>
      </div>`;
  }

  async function placeOrder() {
    alertEl.innerHTML = '';

    // The address typed in so far is kept, so signing in and coming back does
    // not mean typing it again. requireUser does the redirect, and remembers
    // this page as where to return to.
    if (!(await Api.currentUser())) {
      sessionStorage.setItem(ADDRESS_KEY, JSON.stringify(readAddress()));
      await Api.requireUser();
      return;
    }

    const address = readAddress();
    if (!address.name || !address.line1 || !address.city) {
      showAlert('Please fill in your name, address, and city.');
      return;
    }

    // Stash what is on screen now, so if the order is refused the re-render brings
    // back this address rather than whatever was saved on the way to sign in.
    sessionStorage.setItem(ADDRESS_KEY, JSON.stringify(address));

    const button = document.getElementById('place');
    button.disabled = true;
    button.textContent = 'Placing order…';

    try {
      const order = await Api.post('/orders', { items: CartStore.read(), address });
      CartStore.clear();
      sessionStorage.removeItem(ADDRESS_KEY);
      window.location.href = `/orders.html?placed=${order.id}`;
    } catch (err) {
      showAlert(err.message);
      render();
    }
  }

  function shippingLabel(fee) {
    if (fee === null) return 'Unavailable';
    return fee ? Format.money(fee) : 'Free';
  }

  function readAddress() {
    const value = (id) => document.getElementById(id).value.trim();
    return { name: value('f-name'), line1: value('f-line1'), city: value('f-city'), postcode: value('f-postcode') };
  }

  // Reads back what placeOrder stashed before sending a logged-out shopper to
  // sign in. Cleared once an order goes through.
  function readSavedAddress() {
    const blank = { name: '', line1: '', city: '', postcode: '' };
    try {
      const saved = JSON.parse(sessionStorage.getItem(ADDRESS_KEY));
      if (!saved || typeof saved !== 'object') return blank;
      return {
        name: String(saved.name || ''),
        line1: String(saved.line1 || ''),
        city: String(saved.city || ''),
        postcode: String(saved.postcode || ''),
      };
    } catch {
      return blank;
    }
  }

  function showAlert(message) {
    alertEl.insertAdjacentHTML('beforeend', `<div class="alert">${Html.escape(message)}</div>`);
  }
})();
