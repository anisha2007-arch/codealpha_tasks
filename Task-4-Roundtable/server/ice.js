// The ICE servers handed to the browser, built from the environment so they
// can be changed without a rebuild.
//
// STUN alone only tells a browser its public address. It is enough on most
// home and office networks, but two peers behind symmetric NAT or a corporate
// firewall have nothing to connect to and the call fails with nothing more
// diagnostic than connectionState === 'failed'. That case needs TURN, which
// relays the media — and TURN needs credentials, which is why it has its own
// three variables rather than being another entry in STUN_URLS.

function urlList(value) {
  return String(value || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

function iceServers() {
  const servers = urlList(process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .map((urls) => ({ urls }));

  const turnUrls = urlList(process.env.TURN_URL);
  const username = String(process.env.TURN_USERNAME || '').trim();
  const credential = String(process.env.TURN_CREDENTIAL || '').trim();

  if (turnUrls.length) {
    if (!username || !credential) {
      console.warn(
        'TURN_URL is set but TURN_USERNAME or TURN_CREDENTIAL is missing. ' +
          'A TURN server without credentials is ignored by browsers, so it has been left out.'
      );
    } else {
      servers.push({ urls: turnUrls, username, credential });
    }
  }

  return servers;
}

module.exports = { iceServers };
