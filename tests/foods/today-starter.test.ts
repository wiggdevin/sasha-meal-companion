/**
 * W13 (D14): "No starter is marked Favored by default" for an open account, and the Today
 * auto-seed (lib/foods/today-starter.ts) runs only on the SERVER's affirmative
 * `{ world: "closed", starterSeed: true }` (lib/server/food-world.ts `readFoodWorldState`), so
 * every device of the account agrees. This isolates `refreshStarterGate`'s decision alone — every
 * dependency is mocked so the only thing under test is whether `seedZeroFoodAccount` runs (and
 * whether an open default the server says is still due is taken over by this device).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  fetch: vi.fn(), seed: vi.fn(async () => true), saveStoreFor: vi.fn(),
  mark: vi.fn(async () => undefined), drain: vi.fn(async () => "opened"),
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
// No device-local pending flag exists on this device in any case below: the decision is the
// server's alone.
vi.mock("@/lib/foods/world-open-client", () => ({
  markWorldOpenPending: () => mocked.mark(), drainWorldOpenPending: () => mocked.drain(),
}));

import { refreshStarterGate } from "@/lib/foods/today-starter";

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

function serve(world: () => Promise<Response>, access = false) {
  mocked.fetch.mockImplementation((url: string) => {
    if (url === "/api/recipes/access") return ok({ enabled: access });
    if (url === "/api/foods/world") return world();
    throw new Error(`unexpected fetch ${url}`);
  });
}

const LEGACY_CLOSED = { world: "closed", openDefaultPending: false, starterSeed: true };

beforeEach(() => {
  mocked.fetch.mockReset();
  mocked.seed.mockClear();
  mocked.mark.mockClear();
  mocked.drain.mockClear();
  serve(() => ok(LEGACY_CLOSED));
});

describe("refreshStarterGate", () => {
  it("auto-seeds a zero-food legacy CLOSED account, as before", async () => {
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).toHaveBeenCalledTimes(1);
    expect(mocked.mark).not.toHaveBeenCalled();
  });

  it("auto-seeds an account whose world was explicitly chosen closed (legacy behaviour)", async () => {
    // The server answers an explicit closed choice exactly like a legacy closed account.
    serve(() => ok({ world: "closed", openDefaultPending: false, starterSeed: true }));
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).toHaveBeenCalledTimes(1);
  });

  it("never auto-seeds an OPEN account — no default or inherited Favored marks (acceptance 5)", async () => {
    serve(() => ok({ world: "open", openDefaultPending: false, starterSeed: false }));
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
  });

  // Sol round 4 BLOCK, the cross-device case: device A finished onboarding and its open POST
  // answered 503. This is device B: no local pending flag, the server still says `closed`, but the
  // W13 default is due and undecided, so the server says no seed — and B takes the default over.
  it("device B with no local flag never seeds while the server says the open default is pending", async () => {
    serve(() => ok({ world: "closed", openDefaultPending: true, starterSeed: false }));
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocked.drain).toHaveBeenCalledTimes(1));
    expect(mocked.mark).toHaveBeenCalledTimes(1);
  });

  it("a failed take-over of the open default neither throws nor seeds", async () => {
    serve(() => ok({ world: "closed", openDefaultPending: true, starterSeed: false }));
    mocked.mark.mockRejectedValueOnce(new Error("no indexeddb"));
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
  });

  it("never seeds a closed account the server has not onboarded yet", async () => {
    serve(() => ok({ world: "closed", openDefaultPending: false, starterSeed: false }));
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
    expect(mocked.mark).not.toHaveBeenCalled();
  });

  // Sol round 2 BLOCK: a failed or partial read is UNKNOWN, never "closed".
  it.each([
    ["a rejected read", () => Promise.reject(new Error("offline"))],
    ["a 503", () => Promise.resolve(new Response("{}", { status: 503 }))],
    ["a 200 with no world", () => ok({})],
    ["a 200 closed with no starterSeed (an older server)", () => ok({ world: "closed" })],
    ["a 200 closed with a non-boolean starterSeed", () => ok({ world: "closed", starterSeed: "true" })],
    ["an unreadable body", () => Promise.resolve(new Response("not json", { status: 200 }))],
  ])("never seeds on %s of the food world", async (_label, world) => {
    serve(world);
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
    expect(mocked.mark).not.toHaveBeenCalled();
  });

  it("never seeds when the account already has foods, open or closed", async () => {
    serve(() => ok(LEGACY_CLOSED), true); // legacy starter already ran
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocked.seed).not.toHaveBeenCalled();
  });
});
