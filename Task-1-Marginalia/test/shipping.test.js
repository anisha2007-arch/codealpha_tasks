const test = require('node:test');
const assert = require('node:assert/strict');

const { SHIPPING_FEE, FREE_SHIPPING_OVER, shippingFor } = require('../server/shipping');

// The basket page shows this rule and checkout charges by it. They read the
// same function, so these cases pin down the boundary for both at once.
test('shipping is charged below the free threshold', () => {
  assert.equal(shippingFor(0), SHIPPING_FEE);
  assert.equal(shippingFor(FREE_SHIPPING_OVER - 1), SHIPPING_FEE);
});

test('shipping is free at and above the threshold', () => {
  assert.equal(shippingFor(FREE_SHIPPING_OVER), 0);
  assert.equal(shippingFor(FREE_SHIPPING_OVER + 1), 0);
});
