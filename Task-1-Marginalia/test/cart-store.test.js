const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

// The basket lives in localStorage, which outlives a session and belongs to the
// browser rather than to the person signed in. These run the real cart-store.js
// and the real sign-out handler from chrome.js in a DOM, because the question
// is entirely about what survives what.

const JS = path.join(__dirname, '..', 'public', 'js');

// Builds a page with the scripts a real page loads, in the order it loads them.
function page({ user = { id: 1, name: 'Ann' }, scripts = ['cart-store.js'] } = {}) {
  const dom = new JSDOM('<!doctype html><body><div data-header></div></body>', {
    url: 'http://localhost:4000/',
  });
  const { window } = dom;

  const posted = [];
  window.Api = {
    currentUser: async () => user,
    setUser: () => {},
    post: async (p) => { posted.push(p); return null; },
    get: async () => [],
  };
  window.Format = { money: (n) => `£${n}` };
  window.Html = { escape: (s) => String(s) };

  const context = vm.createContext(window);
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), context, { filename: file });
  }
  return { dom, window, context, posted };
}

// Values come back from the page's realm, where Array and Object have
// different prototypes from this file's, and deepStrictEqual compares those.
// Round-tripping through JSON compares the data, which is the question.
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (context) => plain(vm.runInContext('CartStore.read()', context));

test('the basket survives a reload, because that is the whole point of it', () => {
  const first = page();
  vm.runInContext('CartStore.add(3, 2); CartStore.add(7, 1)', first.context);
  const stored = first.window.localStorage.getItem('marginalia-cart');

  // A new page in the same browser: same storage, fresh scripts.
  const second = page();
  second.window.localStorage.setItem('marginalia-cart', stored);
  assert.deepEqual(read(second.context), [{ id: 3, quantity: 2 }, { id: 7, quantity: 1 }]);
});

test('adding the same book twice adds up rather than duplicating the line', () => {
  const { context } = page();
  vm.runInContext('CartStore.add(3, 2); CartStore.add(3, 1)', context);
  assert.deepEqual(read(context), [{ id: 3, quantity: 3 }]);

  vm.runInContext('CartStore.setQuantity(3, 0)', context);
  assert.deepEqual(read(context), [], 'setting a line to zero removes it');
});

// The bug: localStorage is per browser, not per account. Signing out left the
// basket behind, so the next person to sign in on a shared machine inherited
// whatever the last one had been shopping for.
test('signing out empties the basket, so it is not handed to the next person', async () => {
  const { window, context } = page({ scripts: ['cart-store.js', 'chrome.js'] });

  vm.runInContext('CartStore.add(3, 2)', context);
  assert.equal(vm.runInContext('CartStore.count()', context), 2);

  // chrome.js builds the header on DOMContentLoaded and hangs sign-out off it.
  await vm.runInContext('Chrome.renderHeader()', context);
  const signOut = window.document.querySelector('[data-logout]');
  assert.ok(signOut, 'a signed-in header offers a way out');

  signOut.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(read(context), [], 'the basket is empty');
  assert.equal(window.localStorage.getItem('marginalia-cart'), '[]', 'and so is what was stored');
});

test('the badge follows the basket, including down to nothing', async () => {
  const { window, context } = page({ scripts: ['cart-store.js', 'chrome.js'] });
  await vm.runInContext('Chrome.renderHeader()', context);

  const badge = () => window.document.querySelector('[data-cart-count]').textContent;
  assert.equal(badge(), '0');

  vm.runInContext('CartStore.add(3, 2)', context);
  assert.equal(badge(), '2', 'cart:changed updates the badge without a reload');

  vm.runInContext('CartStore.remove(3)', context);
  assert.equal(badge(), '0');
});

// Prices and stock are the catalogue's business. A basket that has been sitting
// in a browser for a week must not be able to state its own prices.
test('a stored line for a book that no longer exists simply drops out', () => {
  const { context } = page();
  vm.runInContext('CartStore.add(1, 1); CartStore.add(999, 4)', context);

  const joined = plain(vm.runInContext(
    'CartStore.withBooks([{ id: 1, title: "A", price: 10 }])',
    context
  ));
  assert.equal(joined.length, 1);
  assert.equal(joined[0].id, 1);
  assert.equal(joined[0].lineTotal, 10, 'the price comes from the catalogue, not from storage');
});

test('a corrupted or hand-edited basket reads as empty rather than throwing', () => {
  const { window, context } = page();

  for (const junk of ['not json', '{"id":1}', '[{"quantity":-1}]', 'null', '[]']) {
    window.localStorage.setItem('marginalia-cart', junk);
    assert.deepEqual(read(context), [], `"${junk}" should read as an empty basket`);
  }
});
