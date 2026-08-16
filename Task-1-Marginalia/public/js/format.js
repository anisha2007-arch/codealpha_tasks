// Turning values into the strings a person reads. Pure functions, no markup.
const Format = (() => {
  // Prices are whole rupees throughout: the API stores and returns integers,
  // so rounding here only guards against a stray float arriving.
  function money(amount) {
    return `₹${Math.round(Number(amount)).toLocaleString('en-IN')}`;
  }

  return { money };
})();
