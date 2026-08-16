// Wrapped in an IIFE so its top-level names stay its own. Page scripts are
// classic scripts sharing one global scope, and two of them each declaring
// `const form` on the same page throw SyntaxError before either runs.
(() => {
  // "next" is assigned straight to window.location.href, including for a visitor
  // who is already signed in, so only a same-origin path may come back from here:
  // "//evil.example" is protocol-relative and "javascript:..." would run in this
  // origin. Anything else falls back to the home page.
  function safeNext(raw) {
    // A browser reads a backslash in a URL as a slash, so "/\evil.example" is
    // protocol-relative too. Normalise before checking.
    const value = String(raw == null ? '' : raw).replace(/\\/g, '/');
    const colon = value.indexOf(':');
    const slash = value.indexOf('/');
    if (colon !== -1 && (slash === -1 || colon < slash)) return '/';
    if (!value.startsWith('/') || value.startsWith('//')) return '/';
    return value;
  }

  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const form = document.getElementById('form');
  const alertEl = document.getElementById('alert');

  let mode = 'signin';

  Api.currentUser().then((user) => { if (user) window.location.href = next; });

  document.getElementById('switch').addEventListener('click', (event) => {
    event.preventDefault();
    setMode(mode === 'signin' ? 'register' : 'signin');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertEl.innerHTML = '';

    const submit = document.getElementById('submit');
    submit.disabled = true;

    const data = new FormData(form);
    const body = { email: data.get('email').trim(), password: data.get('password') };
    if (mode === 'register') {
      body.handle = data.get('handle').trim();
      body.displayName = data.get('displayName').trim();
    }

    try {
      const { user } = await Api.post(mode === 'register' ? '/register' : '/login', body);
      Api.setUser(user);
      window.location.href = next;
    } catch (err) {
      alertEl.innerHTML = `<div class="alert">${Html.escape(err.message)}</div>`;
      submit.disabled = false;
    }
  });

  function setMode(value) {
    mode = value;
    const registering = value === 'register';
    document.getElementById('title').textContent = registering ? 'Join Coterie' : 'Sign in';
    document.getElementById('submit').textContent = registering ? 'Create account' : 'Sign in';
    document.getElementById('switch').textContent = registering ? 'Sign in instead' : 'Create an account';
    document.getElementById('switch-text').textContent = registering
      ? 'Already have an account?'
      : 'New here?';

    document.getElementById('register-fields').hidden = !registering;
    form.elements.handle.required = registering;
    form.elements.displayName.required = registering;
    alertEl.innerHTML = '';
  }
})();
