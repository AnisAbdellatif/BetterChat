// BetterChat's service worker: keeps the chat usable when betterchat.tech
// isn't.
//
// The page is entirely client-side - kick.js talks to kick.com directly for
// both the REST API and the Pusher feed - so once the shell is cached, this
// origin going down costs nothing but the heartbeats, which already fail
// silently. Chat keeps rendering.
//
// The site has no build step, so filenames never change and a long max-age
// from the server would risk pinning viewers to stale JS forever. Versioning
// lives here instead: bump the version on deploy and the old cache is
// dropped on activate.
//
// Two numbers, so the ordinary case is a small edit:
//
//   MINOR - the everyday bump. Any change to a file the worker caches: the
//           page, app.js, kick.js, config.js. Bump this and nothing else.
//   MAJOR - reserved for a change to what caching itself does: a different
//           set of cached assets, a different strategy, or a shell an old
//           cached copy could not work with. Bump it and reset MINOR to 0.
//
// Only the resulting string matters to the browser, and only that it differs
// from the last one - the cleanup below drops every cache that is not the
// current one, so the numbers are for us, not for it.

const MAJOR = 1;
const MINOR = 2;
const VERSION = `v${MAJOR}.${MINOR}`;
const CACHE = `betterchat-${VERSION}`;

// The chat page is served for every unknown path (/xqc, /clix, ...) and
// reads its channel from location.pathname, so one copy under a fixed key
// answers a navigation to any channel.
const SHELL = '/';
const ASSETS = [SHELL, '/app.js', '/kick.js', '/config.js', '/favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
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
