const Api = (() => {
  let cachedUser;

  async function request(path, method = 'GET', body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });

    if (res.status === 204) return null;

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  async function currentUser() {
    if (cachedUser !== undefined) return cachedUser;
    try {
      cachedUser = (await request('/me')).user;
    } catch {
      cachedUser = null;
    }
    return cachedUser;
  }

  // Sends anyone without a session to the sign-in page, remembering where
  // they were headed.
  async function requireUser() {
    const user = await currentUser();
    if (!user) {
      window.location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    return user;
  }

  return {
    get: (p) => request(p),
    post: (p, body) => request(p, 'POST', body),
    put: (p, body) => request(p, 'PUT', body),
    del: (p) => request(p, 'DELETE'),
    currentUser,
    requireUser,
    setUser: (user) => { cachedUser = user; },
  };
})();
