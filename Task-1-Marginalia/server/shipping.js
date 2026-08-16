// The single definition of the shipping rule. Checkout charges with it and
// GET /api/shipping serves it to the basket page, so what the shopper is shown
// and what they are charged can never drift apart.
const SHIPPING_FEE = 60;
const FREE_SHIPPING_OVER = 999;

function shippingFor(subtotal) {
  return subtotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
}

module.exports = { SHIPPING_FEE, FREE_SHIPPING_OVER, shippingFor };
