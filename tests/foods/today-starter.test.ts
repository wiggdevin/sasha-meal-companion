/**
 * W13 (D14): "No starter is marked Favored by default" for an open account, and the Today
 * auto-seed (lib/foods/today-starter.ts:45) does not run for one. This isolates
 * `refreshStarterGate`'s decision alone — every dependency is mocked so the only thing under
 * test is whether `seedZeroFoodAccount` runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  fetch: vi.fn(), seed: vi.fn(async () => true), saveStoreFor: vi.fn(),
}));

vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init?: RequestInit) => mocked.fetch(url, init),
  accountJson: async (_h: unknown, res: Response) => res.json(),
  assertCurrent: () => undefined,
  currentAccountOrNull: () => ({ userId: "account-a", epoch: 1 }),
}));
vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: async () => ({ profile: {}, rev: 1 }),
}));
vi.mock("@/lib/profile/instances-client", () => ({
  fetchProfileInstances: async () => ({ instances: [] }),
}));
vi.mock("@/lib/rule-review-client", () => ({ loadRuleReview: async () => ({ required: false }) }));
vi.mock("@/lib/store", () => ({
  loadStore: () => ({ settings: {} }), saveStoreFor: mocked.saveStoreFor,
}));
vi.mock("@/lib/foods/starter-seed", () => ({ seedZeroFoodAccount: mocked.seed }));

import { refreshStarterGate } from "@/lib/foods/today-starter";

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  mocked.fetch.mockReset();
  mocked.seed.mockClear();
  mocked.fetch.mockImplementation((url: string) => {
    if (url === "/api/recipes/access") return ok({ enabled: false });
    if (url === "/api/foods/world") return ok({ world: "closed" });
    throw new Error(`unexpected fetch ${url}`);
  });
});

describe("refreshStarterGate", () => {
  it("auto-seeds a zero-food CLOSED account, as before", async () => {
    const status = await refreshStarterGate();
    expect(status).toBe("ready");
    expect(mocked.seed).toHaveBeenCalledTimes(1);
  });

  it("never auto-seeds an OPEN account — no default or inherited Favored marks (acceptance 5)", async () => {
    mocked.fetch.mockImplementation((url: string) => {
      if (url === "/api/recipes/access") return ok({ enabled: false });
      if (url === "/api/foods/world") return ok({ world: "open" });
      throw new Error(`unexpected fetch ${url}`);
    });
    const status = await refreshStarterGate();
    expect(status).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
  });

  it("treats a failed food-world read as closed, preserving the pre-existing seed behaviour", async () => {
    mocked.fetch.mockImplementation((url: string) => {
      if (url === "/api/recipes/access") return ok({ enabled: false });
      if (url === "/api/foods/world") return Promise.reject(new Error("offline"));
      throw new Error(`unexpected fetch ${url}`);
    });
    const status = await refreshStarterGate();
    expect(status).toBe("ready");
    expect(mocked.seed).toHaveBeenCalledTimes(1);
  });

  it("never seeds when the account already has foods, open or closed", async () => {
    mocked.fetch.mockImplementation((url: string) => {
      if (url === "/api/recipes/access") return ok({ enabled: true }); // legacy starter already ran
      if (url === "/api/foods/world") return ok({ world: "closed" });
      throw new Error(`unexpected fetch ${url}`);
    });
    const status = await refreshStarterGate();
    expect(status).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
  });
});
