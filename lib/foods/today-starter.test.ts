import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFetch: vi.fn(),
  accountJson: vi.fn(),
  assertCurrent: vi.fn(),
  loadConstraints: vi.fn(),
  fetchProfileInstances: vi.fn(),
  loadRuleReview: vi.fn(),
  loadStore: vi.fn(),
  saveStoreFor: vi.fn(),
  seedZeroFoodAccount: vi.fn(),
}));

const account = { userId: "11111111-1111-4111-8111-111111111111", epoch: 1 };
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => account,
  currentAccountOrNull: () => account,
  accountFetch: mocks.accountFetch,
  accountJson: mocks.accountJson,
  assertCurrent: mocks.assertCurrent,
}));
vi.mock("@/lib/constraints-client", () => ({ loadConstraints: mocks.loadConstraints }));
vi.mock("@/lib/profile/instances-client", () => ({ fetchProfileInstances: mocks.fetchProfileInstances }));
vi.mock("@/lib/rule-review-client", () => ({ loadRuleReview: mocks.loadRuleReview }));
vi.mock("@/lib/store", () => ({ loadStore: mocks.loadStore, saveStoreFor: mocks.saveStoreFor }));
vi.mock("@/lib/foods/starter-seed", () => ({ seedZeroFoodAccount: mocks.seedZeroFoodAccount }));
vi.mock("@/lib/foods/world-open-client", () => ({
  markWorldOpenPending: async () => undefined, drainWorldOpenPending: async () => undefined,
}));

import { refreshStarterGate } from "./today-starter";

const profile = { avoid_allergens: [], avoid_ref_ids: [] };
const instances = [{ profileId: "balanced" }];

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.loadRuleReview.mockResolvedValue({ required: false });
  mocks.loadConstraints.mockResolvedValue({ profile });
  mocks.fetchProfileInstances.mockResolvedValue({ instances });
  mocks.loadStore.mockReturnValue({ settings: { ruleReviewReady: false }, foods: {} });
  mocks.accountFetch.mockResolvedValue({ ok: true });
  mocks.accountJson.mockResolvedValue({ enabled: true });
  mocks.seedZeroFoodAccount.mockResolvedValue(true);
});

describe("Today starter gate", () => {
  it("leaves a recipe-enabled account's Eats empty while marking reviewed rules ready", async () => {
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocks.accountFetch).toHaveBeenCalledWith(account, "/api/recipes/access",
      { cache: "no-store" }, { budget: "prefs" });
    expect(mocks.seedZeroFoodAccount).not.toHaveBeenCalled();
    expect(mocks.loadRuleReview).toHaveBeenCalledWith({ account });
    expect(mocks.saveStoreFor).toHaveBeenLastCalledWith(account,
      expect.objectContaining({ settings: expect.objectContaining({ ruleReviewReady: true }) }),
      { silent: true });
  });

  it("preserves the legacy starter for an explicitly disabled account", async () => {
    // W13 round 5: the legacy seed needs the server's exact { world: "closed", starterSeed: true }
    // (one body answers both reads).
    mocks.accountJson.mockResolvedValue({ enabled: false, world: "closed", starterSeed: true,
      openDefaultPending: false });
    expect(await refreshStarterGate()).toBe("ready");
    expect(mocks.seedZeroFoodAccount).toHaveBeenCalledOnce();
    expect(mocks.seedZeroFoodAccount).toHaveBeenCalledWith(profile, instances);
  });

  it("does not seed while the access decision is still loading", async () => {
    let resolveAccess!: (response: { ok: boolean }) => void;
    mocks.accountFetch.mockReturnValue(new Promise((resolve) => { resolveAccess = resolve; }));
    const pending = refreshStarterGate();
    await Promise.resolve();
    expect(mocks.seedZeroFoodAccount).not.toHaveBeenCalled();
    resolveAccess({ ok: true });
    expect(await pending).toBe("ready");
    expect(mocks.seedZeroFoodAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", () => mocks.accountFetch.mockRejectedValue(new Error("offline"))],
    ["HTTP failure", () => mocks.accountFetch.mockResolvedValue({ ok: false })],
    ["missing decision", () => mocks.accountJson.mockResolvedValue({})],
  ])("does not seed when access has a %s", async (_label, arrange) => {
    arrange();
    expect(await refreshStarterGate()).toBe("unavailable");
    expect(mocks.seedZeroFoodAccount).not.toHaveBeenCalled();
    expect(mocks.saveStoreFor).toHaveBeenLastCalledWith(account,
      expect.objectContaining({ settings: expect.objectContaining({ ruleReviewReady: false }) }),
      { silent: true });
  });

  it("keeps required rule review ahead of the starter even when access is disabled or unavailable", async () => {
    mocks.loadRuleReview.mockResolvedValue({ required: true });
    mocks.accountFetch.mockRejectedValue(new Error("offline"));
    expect(await refreshStarterGate()).toBe("review");
    expect(mocks.seedZeroFoodAccount).not.toHaveBeenCalled();
    expect(mocks.saveStoreFor).toHaveBeenLastCalledWith(account,
      expect.objectContaining({ settings: expect.objectContaining({ ruleReviewReady: false }) }),
      { silent: true });
  });
});
