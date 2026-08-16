const test = require('node:test');
const assert = require('node:assert/strict');

const { hasControlChars } = require('../server/text');

// A NUL byte in a registration field used to reach Postgres, which answered
// `invalid byte sequence for encoding "UTF8": 0x00` — a 500 for what is a bad
// request. This is the screen that stops it, and it is one of the files that
// has to be the same in all four projects, so each of them has this test.

test('a NUL byte is refused wherever it appears', () => {
  assert.equal(hasControlChars('Ann\u0000a'), true);
  assert.equal(hasControlChars('Ann\u0000a', { allowBreaks: true }), true);
  assert.equal(hasControlChars('\u0000'), true);
});

test('the rest of the C0 range and DEL go too', () => {
  assert.equal(hasControlChars('a\u0007b'), true);
  assert.equal(hasControlChars('a\u001bb'), true);
  assert.equal(hasControlChars('a\u007fb'), true);
});

test('line breaks pass only where a caller asked for them', () => {
  assert.equal(hasControlChars('one\ntwo', { allowBreaks: true }), false);
  assert.equal(hasControlChars('one\r\ntwo', { allowBreaks: true }), false);
  assert.equal(hasControlChars('a\tb', { allowBreaks: true }), false);
  // A name is one line.
  assert.equal(hasControlChars('one\ntwo'), true);
  assert.equal(hasControlChars('a\tb'), true);
});

test('ordinary text is left alone', () => {
  for (const value of ['Anna Smith', 'Zoë Müller', 'Anna 🙂', '田中さん', 'a@b.com', '']) {
    assert.equal(hasControlChars(value), false, value);
  }
});
