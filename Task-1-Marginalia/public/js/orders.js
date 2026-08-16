// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const alertEl` on the same page throw SyntaxError before either runs.
(() => {
  const listEl = document.getElementById('orders');
  const alertEl = document.getElementById('alert');

  // The statuses a shopper can move an order to themselves. Shipped and
  // Delivered belong to the shop, so they are left to the API.
  const ACTION_LABELS = { Paid: 'Pay now', Cancelled: 'Cancel order' };

  (async () => {
    if (!(await Api.requireUser())) return;

    const placed = new URLSearchParams(location.search).get('placed');
    if (placed) {
      alertEl.innerHTML = `<div class="alert success">Order #${Html.escape(placed)} is confirmed.</div>`;
    }

    load();
  })();

  async function load() {
    try {
      const orders = await Api.get('/orders');
      listEl.innerHTML = orders.length
        ? orders.map(orderHTML).join('')
        : `<div class="notice empty">
             <h2>No orders yet</h2>
             <p>Anything you buy will be listed here.</p>
             <a class="btn" href="/">Start browsing</a>
           </div>`;
      wireActions();
    } catch (err) {
      listEl.innerHTML = `<p class="notice">${Html.escape(err.message)}</p>`;
    }
  }

  function wireActions() {
    listEl.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await Api.post(`/orders/${btn.dataset.order}/status`, { status: btn.dataset.status });
          alertEl.innerHTML = '';
          await load();
        } catch (err) {
          alertEl.innerHTML = `<div class="alert">${Html.escape(err.message)}</div>`;
          btn.disabled = false;
        }
      });
    });
  }

  function orderHTML(order) {
    const a = order.address;
    return `
      <article class="order">
        <div class="order-head">
          <div>
            <strong>Order #${order.id}</strong>
            <span class="order-date">${new Date(order.createdAt).toLocaleString()}</span>
          </div>
          <span class="status">${Html.escape(order.status)}</span>
        </div>
        ${order.items.map(itemHTML).join('')}
        <div class="order-row"><span>Subtotal</span><span>${Format.money(order.subtotal)}</span></div>
        <div class="order-row"><span>Shipping</span><span>${order.shipping ? Format.money(order.shipping) : 'Free'}</span></div>
        <div class="order-row grand"><span>Total</span><span>${Format.money(order.total)}</span></div>
        <p class="order-address">
          Delivered to ${Html.escape(a.name)}, ${Html.escape(a.line1)},
          ${Html.escape(a.city)} ${Html.escape(a.postcode || '')}
        </p>
        ${actionsHTML(order)}
      </article>`;
  }

  // Driven by the nextStatuses the API reports, so the allowed moves are only
  // ever defined once, on the server.
  function actionsHTML(order) {
    const buttons = (order.nextStatuses || [])
      .filter((status) => ACTION_LABELS[status])
      .map((status) => `
        <button class="btn small" data-order="${order.id}" data-status="${status}">
          ${ACTION_LABELS[status]}
        </button>`);
    return buttons.length ? `<div class="order-actions">${buttons.join('')}</div>` : '';
  }

  function itemHTML(item) {
    return `
      <div class="order-row">
        <span>${item.quantity} × ${Html.escape(item.title)}
          <small>${Html.escape(item.author)}</small></span>
        <span>${Format.money(item.price * item.quantity)}</span>
      </div>`;
  }
})();
