import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The install caches "/" and every build asset its HTML names (reload review r1 #7 / r2 #4). Next 16
 * repeats chunk URLs inside the inline RSC flight strings as `\"/_next/static/chunks/<id>.js\"`. A
 * match that runs through the backslash asks for `<id>.js\`, which the browser sends as `<id>.js/`
 * and the server answers with a 308, so the whole install failed (W053 verification, 2026-10-11).
 * Loads the real public/sw.js.
 */
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");

const HTML = [
  "<!DOCTYPE html><html><head>",
  '<link rel="stylesheet" href="/_next/static/css/app.css" data-precedence="next"/>',
  '<script src="/_next/static/chunks/webpack-1a2b.js" async=""></script>',
  "</head><body>",
  // Flight data: one chunk also named by a <script>, one named only here.
  '<script>self.__next_f.push([1,"2:I[\\"(app)\\",[\\"/_next/static/chunks/webpack-1a2b.js\\",' +
    '\\"/_next/static/chunks/lazy-9f8e.js\\"],\\"default\\"]\\n"])</script>',
  "</body></html>",
].join("");

type Served = { status?: number; body?: string; redirected?: boolean };

function loadWorker(routes: Record<string, Served>) {
  const requested: string[] = [];
  const cached: string[] = [];
  const cache = { put: async (url: string) => { cached.push(url); }, match: async () => undefined };
  const fetch = async (input: string) => {
    // What the browser does with a trailing backslash in a URL path.
    const url = input.replace(/\\/g, "/");
    requested.push(url);
    const route = routes[url];
    if (!route) return new Response("missing", { status: url.endsWith("/") && url !== "/" ? 308 : 404 });
    const response = new Response(route.body ?? "ok", { status: route.status ?? 200 });
    if (route.redirected) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    location: { origin: "https://sasha.example" },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [] },
  };
  const caches = { open: async () => cache, match: async () => undefined, keys: async () => [], delete: async () => true };
  const context = { self, caches, fetch, URL, Response, Promise, console };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return { listeners, requested, cached };
}

async function install(listeners: Record<string, (event: unknown) => void>): Promise<"ok" | "failed"> {
  let done: Promise<unknown> = Promise.resolve();
  listeners.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  return done.then(() => "ok" as const, () => "failed" as const);
}

const ASSETS = ["/_next/static/css/app.css", "/_next/static/chunks/webpack-1a2b.js", "/_next/static/chunks/lazy-9f8e.js"];

describe("service worker shell install with escaped flight-data chunk URLs", () => {
  it("caches every real asset, including one named only in flight data, and fetches no bogus URL", async () => {
    const routes: Record<string, Served> = { "/": { body: HTML } };
    for (const url of ASSETS) routes[url] = {};
    const { listeners, requested, cached } = loadWorker(routes);

    expect(await install(listeners)).toBe("ok");
    expect(requested.filter((url) => url.includes("/_next/static/")).sort()).toEqual([...ASSETS].sort());
    expect(requested.some((url) => url.endsWith(".js/") || url.includes("\\"))).toBe(false);
    for (const url of [...ASSETS, "/"]) expect(cached).toContain(url);
  });

  it("still fails the install when a chunk the HTML loads cannot be fetched", async () => {
    const routes: Record<string, Served> = { "/": { body: HTML } };
    for (const url of ASSETS.filter((u) => !u.includes("lazy"))) routes[url] = {};
    const { listeners, cached } = loadWorker(routes);

    expect(await install(listeners)).toBe("failed");
    expect(cached).not.toContain("/");
  });

  it("still fails the install when \"/\" redirects (a signed-out visit)", async () => {
    const routes: Record<string, Served> = { "/": { body: HTML, redirected: true } };
    for (const url of ASSETS) routes[url] = {};
    const { listeners, cached } = loadWorker(routes);

    expect(await install(listeners)).toBe("failed");
    expect(cached).not.toContain("/");
  });
});
