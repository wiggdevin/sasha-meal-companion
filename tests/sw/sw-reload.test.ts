import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Phase 9 slice 1 (reload reviews r4 #1, r5 #1/#5/#6, decision 2026-09-23): the service worker
 * never drives open tabs. It does not skip waiting, does not claim, and never navigates, reloads or
 * messages a window: a forced navigation can lose a tab's unsaved in-memory edit. A new worker
 * waits until the old build's tabs are closed; an old tab keeps the old build until its next
 * natural load or launch, as production behaves today. Loads the real public/sw.js.
 */
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");

type WindowClient = {
  id: string; url: string; navigate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>;
};

function windowClient(id: string, url: string): WindowClient {
  return { id, url, navigate: vi.fn(async () => undefined), postMessage: vi.fn() };
}

function loadWorker(windows: WindowClient[]) {
  const deleted: string[] = [];
  const caches = {
    open: async () => ({ put: async () => undefined, match: async () => undefined }),
    match: async () => undefined,
    keys: async () => ["sasha-shell-v2", "sasha-shell-v3"],
    delete: async (key: string) => { deleted.push(key); return true; },
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const clients = {
    claim: vi.fn(async () => {}),
    matchAll: vi.fn(async () => windows),
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    location: { origin: "https://sasha.example" },
    skipWaiting: vi.fn(),
    clients,
  };
  const context = { self, caches, fetch: async () => new Response("ok"), URL, Response, Promise, console };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return { listeners, clients, deleted, self };
}

async function run(listeners: Record<string, (event: unknown) => void>, type: string): Promise<void> {
  let done: Promise<unknown> = Promise.resolve();
  listeners[type]({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done.catch(() => undefined);
}

describe("service worker v3 never drives open tabs", () => {
  it("activation keeps only the v3 shell cache and never navigates, reloads, messages or claims a window", async () => {
    const a = windowClient("a", "https://sasha.example/");
    const b = windowClient("b", "https://sasha.example/foods");
    const { listeners, clients, deleted } = loadWorker([a, b]);
    await run(listeners, "activate");
    expect(deleted).toEqual(["sasha-shell-v2"]);
    expect(clients.claim).not.toHaveBeenCalled();
    for (const w of [a, b]) {
      expect(w.navigate).not.toHaveBeenCalled();
      expect(w.postMessage).not.toHaveBeenCalled();
    }
  });

  it("a new worker waits: install does not skip waiting", async () => {
    const { listeners, self } = loadWorker([]);
    await run(listeners, "install");
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  // FluidVoice update availability: the one message it answers is the page's own explicit Reload.
  it("skips waiting only when a page asks with SKIP_WAITING, and still never drives a window", () => {
    const a = windowClient("a", "https://sasha.example/");
    const { listeners, self, clients } = loadWorker([a]);
    for (const data of [undefined, null, "SKIP_WAITING", { type: "RELOAD" }, { kind: "SKIP_WAITING" }]) {
      listeners.message({ data });
    }
    expect(self.skipWaiting).not.toHaveBeenCalled();
    listeners.message({ data: { type: "SKIP_WAITING" } });
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
    expect(clients.claim).not.toHaveBeenCalled();
    expect(clients.matchAll).not.toHaveBeenCalled();
    expect(a.navigate).not.toHaveBeenCalled();
    expect(a.postMessage).not.toHaveBeenCalled();
  });
});
