import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { reloadTarget } from "@/lib/device/departure";

/**
 * Phase 9 slice 1, reload boundary: leaving an account ends in `location.replace(location.href)`.
 * Offline, that navigation must still open the app from the shell cache, or the next account (or
 * the same one, back again) could not start at all. Loads the real public/sw.js.
 */
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://sasha.example";

type Cached = Record<string, string>;

const put: string[] = [];

function loadWorker(cached: Cached, fetchImpl?: (url: string) => Promise<Response>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const match = async (req: Request | string) => {
    const url = typeof req === "string" ? new URL(req, ORIGIN).pathname : new URL(req.url).pathname;
    return cached[url] === undefined ? undefined : new Response(cached[url], { status: 200 });
  };
  const caches = {
    open: async () => ({ put: async (req: string) => { put.push(req); }, match }),
    match,
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  const offlineFetch = async () => { throw new TypeError("Failed to fetch"); };
  const context = { self, caches, fetch: fetchImpl ?? offlineFetch, URL, Response, Promise, console };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return listeners;
}

async function navigate(listeners: Record<string, (event: unknown) => void>, pathname: string) {
  let responded: Promise<Response> | null = null;
  listeners.fetch({
    request: { method: "GET", mode: "navigate", url: `${ORIGIN}${pathname}` },
    respondWith: (p: Promise<Response>) => { responded = p; },
  });
  expect(responded).not.toBeNull();
  return responded as unknown as Promise<Response>;
}

describe("service worker: the reload after an account change, offline", () => {
  it("serves the cached page for the path the reload asked for", async () => {
    const listeners = loadWorker({ "/": "<shell>", "/foods": "<foods page>" });
    const res = await navigate(listeners, "/foods");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<foods page>");
  });

  it("falls back to the cached app shell for a path it never cached", async () => {
    const listeners = loadWorker({ "/": "<shell>" });
    const res = await navigate(listeners, "/settings");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<shell>");
  });
});

describe("service worker: an update never leaves the phone without an offline shell (reload r1 #7)", () => {
  async function install(fetchImpl: (url: string) => Promise<Response>): Promise<unknown> {
    const listeners = loadWorker({}, fetchImpl);
    let done: Promise<unknown> = Promise.resolve();
    listeners.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    return done;
  }

  it("fails the install when the app shell cannot be cached, so the old worker and cache stay", async () => {
    await expect(install(async (url) => {
      if (url === "/") throw new TypeError("Failed to fetch");
      return new Response("ok");
    })).rejects.toBeTruthy();
    await expect(install(async (url) => new Response("", { status: url === "/" ? 500 : 200 })))
      .rejects.toBeTruthy();
  });

  it("fails the install when '/' was redirected (a signed-out visit gets /sign-in, not the app)", async () => {
    const redirected = () => {
      const res = new Response("<sign-in>");
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    };
    await expect(install(async (url) => (url === "/" ? redirected() : new Response("ok"))))
      .rejects.toBeTruthy();
  });

  it("caches every build chunk the shell loads, and fails when one cannot be fetched", async () => {
    put.length = 0;
    const html = '<script src="/_next/static/chunks/app-1.js"></script>'
      + '<link href="/_next/static/css/a.css" rel="stylesheet">';
    await expect(install(async (url) => new Response(url === "/" ? html : "x")))
      .resolves.toBeDefined();
    expect(put).toEqual(expect.arrayContaining(
      ["/", "/_next/static/chunks/app-1.js", "/_next/static/css/a.css"]));
    await expect(install(async (url) => {
      if (url.includes("app-1.js")) throw new TypeError("Failed to fetch");
      return new Response(url === "/" ? html : "x");
    })).rejects.toBeTruthy();
  });

  it("installs when the shell is cached, even if an icon fails", async () => {
    await expect(install(async (url) => {
      if (url.endsWith(".png")) throw new TypeError("Failed to fetch");
      return new Response("ok");
    })).resolves.toBeDefined();
  });
});

describe("the departure's reload target (reload review r3 #3)", () => {
  const cached = (urls: string[]) => async (url: string) =>
    (urls.includes(new URL(url, ORIGIN).pathname) ? new Response("") : undefined);

  it("reloads the same page when its document is cached", async () => {
    expect(await reloadTarget(`${ORIGIN}/foods`, cached(["/", "/foods"]))).toBe(`${ORIGIN}/foods`);
  });

  it("goes to '/' (the guaranteed shell) when the page's document is not cached", async () => {
    expect(await reloadTarget(`${ORIGIN}/settings`, cached(["/"]))).toBe("/");
    expect(await reloadTarget(`${ORIGIN}/settings`, async () => { throw new Error("x"); })).toBe("/");
  });

  it("keeps the page when there is no service worker cache at all", async () => {
    expect(await reloadTarget(`${ORIGIN}/settings`, null)).toBe(`${ORIGIN}/settings`);
  });
});
