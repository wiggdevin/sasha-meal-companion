import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Loads the real public/sw.js into a sandboxed ServiceWorkerGlobalScope so its
 * actual `fetch` handler runs, instead of re-implementing its logic here.
 */
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");

function loadServiceWorker(fetchImpl: (req: unknown) => Promise<Response>) {
  const cacheStore = new Map<string, Response>();
  const cache = {
    put: async (req: { url: string } | string, res: Response) => {
      cacheStore.set(typeof req === "string" ? req : req.url, res);
    },
    match: async (req: { url: string } | string) => cacheStore.get(typeof req === "string" ? req : req.url),
  };
  const caches = {
    open: async () => cache,
    match: (req: { url: string } | string) => cache.match(req),
    keys: async () => ["sasha-shell-v2"],
    delete: async () => true,
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    location: { origin: "https://sasha.example" },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const context = { self, caches, fetch: fetchImpl, URL, Response, Promise, console };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return listeners;
}

function fakeGetRequest(url: string) {
  return { method: "GET", url, mode: "same-origin" };
}

function dispatchFetch(listeners: Record<string, (event: unknown) => void>, request: unknown) {
  let respondWithPromise: Promise<Response> | undefined;
  listeners.fetch({ request, respondWith: (p: Promise<Response>) => { respondWithPromise = p; } });
  return respondWithPromise;
}

describe("the service worker's handling of /api/ requests", () => {
  it("does not resolve a stale cached body when the network fails on a later load", async () => {
    const url = "https://sasha.example/api/health/daily?from=2026-09-15&to=2026-09-15";
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ fresh: true }), { status: 200 });
      throw new TypeError("network offline");
    };
    const listeners = loadServiceWorker(fetchImpl);

    // First load: online. The response is real and gets a chance to be cached.
    const first = await dispatchFetch(listeners, fakeGetRequest(url));
    expect(first?.status).toBe(200);

    // Second load, same URL (the day-stable from/to query repeats): offline.
    // The SW must not silently serve the stale cached 200 as if it were live —
    // the page's own fetch() needs to see a failure so its offline detection
    // (lib/health-client.ts) actually fires.
    await expect(dispatchFetch(listeners, fakeGetRequest(url))).rejects.toThrow();
  });
});
