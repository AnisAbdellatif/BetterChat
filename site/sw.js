// BetterChat's service worker: keeps the chat usable when betterchat.tech
// isn't.
//
// The page is entirely client-side - kick.js talks to kick.com directly for
// both the REST API and the Pusher feed - so once the shell is cached, this
// origin going down costs nothing but the heartbeats, which already fail
// silently. Chat keeps rendering.
//
// The site has no build step, so filenames never change and a long max-age
// from the server would risk pinning viewers to stale JS forever. Instead the
// cache is named after a hash of the site's files, which the server writes
// into this script as it serves it (the /sw.js route in betterchat/main.py).
//
// Change any file under site/ and the hash changes. That changes this
// script's bytes, which is what makes the browser install the new worker; the
// new worker fills a cache under the new name, and activate drops the old
// one. Nothing to bump by hand.
//
// Served by anything other than that server - a plain static host - the
// placeholder stays as written. The worker still works; it just never
// retires its cache on its own.
const BUILD = '__BETTERCHAT_BUILD__';
const CACHE = `betterchat-${BUILD}`;

// The chat page is served for every unknown path (/xqc, /clix, ...) and
// reads its channel from location.pathname, so one copy under a fixed key
// answers a navigation to any channel.
const SHELL = '/';
const ASSETS = [SHELL, '/app.js', '/settings.js', '/defaults.json', '/kick.js', '/config.js', '/favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Past the HTTP cache: what goes in under this build's name has to be
      // the files this build is made of, not a copy the browser kept.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Scripts and the icon: answer from cache at once, refresh in the background
// so the next load has the new copy. One deploy behind at worst, and instant
// on every load.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// Navigations: try the network so a deploy is picked up immediately, and
// fall back to the cached shell when the origin can't be reached.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(SHELL, res.clone());
    return res;
  } catch (err) {
    const shell = await cache.match(SHELL);
    if (shell) return shell;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Kick's API, its emote images and the Pusher feed are all cross-origin
  // and must never be touched here.
  if (url.origin !== self.location.origin) return;
  // Heartbeats and the admin board are live data, never cached. The privacy
  // policy is skipped for a subtler reason: navigations are cached under the
  // fixed SHELL key, so letting it through here would overwrite the cached
  // chat page with the policy and serve that to an offline viewer.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/admin') ||
    url.pathname === '/privacy' ||
    url.pathname === '/privacy.html'
  ) {
    return;
  }

  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : staleWhileRevalidate(request));
});
