/**
 * Service worker for Sasha.
 *
 * Offline-capable app shell (PRD acceptance criterion 4). All of Sasha's data
 * lives in localStorage, which this worker never touches — only network
 * responses (HTML, JS/CSS chunks, icons, manifest) are cached here.
 *
 * Strategy:
 *   - Navigations and HTML: NETWORK FIRST, cache as the offline fallback. A
 *     deploy is visible on the next open with signal; with no signal she gets
 *     the last shell she saw.
 *   - Hashed build assets under /_next/static/: cache first. Their URLs change
 *     on every build, so a cached one is never stale.
 *   - Same-origin /api/ requests: network only, never cached, never served
 *     stale. The app layer relies on these failing when the network is down.
 *   - Everything else same-origin: network first, cache fallback.
 *
 * Bump CACHE_VERSION on any strategy change; activate() clears every cache
 * that doesn't match the current version.
 */

// v3 (Phase 9 slice 1): a verified offline shell; the worker waits for the old build's tabs to
// close instead of taking them over (see the activate handler).
const CACHE_VERSION = "v3";
const CACHE_NAME = `sasha-shell-${CACHE_VERSION}`;

const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

// Reload review r1 #7 / r2 #4: an install succeeds only with a usable offline shell: "/" itself
// (not a redirect to /sign-in, which a signed-out visit gets) and every build chunk its HTML loads.
// Otherwise install fails and the old worker keeps its cache. Activation deletes the old cache, and
// every account change ends in a reload that may be offline. The icons stay best effort.
// A match stops at a backslash too: Next 16 repeats each chunk URL inside the inline RSC flight
// strings (`self.__next_f.push(...)`) as `\"/_next/static/chunks/<id>.js\"`. Read through the
// backslash, that URL ends in `\`, which the browser fetches as `<id>.js/`; the server answers 308,
// requireOk rejects it and the whole install fails. Stopping there still caches the chunk itself.
const ASSET_PATTERN = /\/_next\/static\/[^"'\s)\\]+/g;

function requireOk(response) {
  if (!response || !response.ok || response.redirected) throw new Error("shell_not_cached");
  return response;
}

function cacheShell(cache) {
  return fetch("/")
    .then(requireOk)
    .then((response) =>
      response
        .clone()
        .text()
        .then((html) => {
          const assets = Array.from(new Set(html.match(ASSET_PATTERN) || []));
          return Promise.all(
            assets.map((url) => fetch(url).then(requireOk).then((asset) => cache.put(url, asset))),
          );
        })
        .then(() => cache.put("/", response)),
    );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all([
          cacheShell(cache),
          ...SHELL_URLS.filter((url) => url !== "/").map((url) =>
            fetch(url)
              .then((response) => (response && response.ok ? cache.put(url, response) : undefined))
              .catch(() => undefined),
          ),
        ]),
      ),
  );
});

// Reload reviews r4 #1, r5 #1/#5/#6 (decision 2026-09-23): this worker never drives open tabs. It
// does not skip waiting on its own (only on a page's explicit SKIP_WAITING, below) or claim, and it
// never navigates, reloads or messages a window, because a forced navigation can lose a tab's
// unsaved in-memory edit. It activates once the old build's
// tabs are closed; an old tab keeps the old build until its next natural load or launch, as
// production behaves today. Only then are the older shell caches deleted.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
});

// FluidVoice update availability (2026-09-28): the one exception to "never drives open tabs" is a
// page's own explicit Reload. That page posts SKIP_WAITING to this waiting worker, which activates;
// the page that asked reloads itself once on its controller change (components/ServiceWorkerRegistrar
// .tsx). This worker still never claims, navigates, reloads or messages a window, and ignores any
// other message.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function putInCache(request, response) {
  // A redirect (a signed-out visit sent to /sign-in) is never kept as the page it was asked for.
  if (response && response.ok && !response.redirected) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

function networkFirst(request, fallbackToRoot) {
  return fetch(request)
    .then((response) => putInCache(request, response))
    .catch(() =>
      caches.match(request).then((cached) => {
        if (cached) return cached;
        if (fallbackToRoot) return caches.match("/");
        return new Response("", { status: 504, statusText: "Offline" });
      }),
    );
}

function cacheFirst(request) {
  return caches.match(request).then((cached) => cached || fetch(request).then((response) => putInCache(request, response)));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, true));
    return;
  }
  // Dev chunks are not content-hashed, so cache-first would pin stale code
  // on localhost. Production chunk URLs change on every build.
  if (url.pathname.startsWith("/_next/static/") && url.hostname !== "localhost") {
    event.respondWith(cacheFirst(request));
    return;
  }
  // The ground video is versioned in its filename; fetch it once, keep it.
  if (/^\/ground-v\d+/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // API responses must never be served stale-from-cache: the app layer
  // (e.g. lib/health-client.ts) tells "offline" from "live" by whether its
  // own fetch() rejects. Pass these straight through so a network failure
  // stays a failure instead of resolving with an old cached 200.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }
  event.respondWith(networkFirst(request, false));
});
