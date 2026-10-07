import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  fetch: vi.fn(), mutate: vi.fn(), flush: vi.fn(), sync: vi.fn(), loadStore: vi.fn(), saveStore: vi.fn(),
  assert: vi.fn(), account: { userId: "account-a", epoch: 1 },
}));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => mocked.account,
  accountFetch: mocked.fetch,
  accountJson: async (_handle: unknown, response: Response) => response.json(),
  assertCurrent: mocked.assert,
}));
vi.mock("@/lib/store", () => ({ loadStore: mocked.loadStore, saveStore: mocked.saveStore }));
vi.mock("@/lib/sync/outbox", () => ({ mutateUserSettings: mocked.mutate,
  USER_SETTINGS_KEY: "user_settings" }));
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: mocked.flush, syncOnce: mocked.sync }));

import { saveDiet } from "@/lib/foods/diet-client";

beforeEach(() => {
  for (const mock of [mocked.fetch, mocked.mutate, mocked.flush, mocked.sync, mocked.loadStore,
    mocked.saveStore, mocked.assert]) mock.mockReset();
  mocked.mutate.mockImplementation(async (_h, edit) => edit({ rev: 4,
    diet_prefs: { flags: ["vegan"], lifestyle: { cookingEffort: "balanced" } } }));
  mocked.loadStore.mockReturnValue({ settings: { dietPrefs: {
    flags: ["vegan"], lifestyle: { cookingEffort: "minimal" },
  } } });
  mocked.fetch.mockResolvedValueOnce(Response.json({ dietPrefs: { flags: ["vegan"],
    lifestyle: { cookingEffort: "minimal" } }, rev: 4 }))
    .mockResolvedValueOnce(Response.json({ dietPrefs: { flags: ["vegetarian"],
      lifestyle: { cookingEffort: "minimal" } }, rev: 5 }));
  mocked.flush.mockResolvedValue(true);
});

describe("diet confirmation", () => {
  it("folds the field into the shared settings outbox and verifies persisted flags", async () => {
    const result = await saveDiet(["vegetarian"], 4);
    expect(mocked.mutate).toHaveBeenCalledWith(mocked.account, expect.any(Function));
    const queued = mocked.mutate.mock.results[0].value;
    expect((await queued).op.payload.diet_prefs).toEqual({
      flags: ["vegetarian"], lifestyle: { cookingEffort: "minimal" },
    });
    expect((await queued).op.payload).toEqual({ diet_prefs: {
      flags: ["vegetarian"], lifestyle: { cookingEffort: "minimal" },
    } });
    expect(mocked.flush).toHaveBeenCalledWith(mocked.account);
    expect(mocked.sync).toHaveBeenCalledWith(mocked.account);
    expect(mocked.saveStore).toHaveBeenCalledOnce();
    expect(result.rev).toBe(5);
    expect(mocked.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not claim a queued write was saved", async () => {
    mocked.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(saveDiet(["vegetarian"], 4)).rejects.toThrow("queued");
    expect(mocked.saveStore).not.toHaveBeenCalled();
  });

  it("rejects a stale editor revision before queuing", async () => {
    await expect(saveDiet(["vegetarian"], 3)).rejects.toThrow("changed elsewhere");
    expect(mocked.mutate).not.toHaveBeenCalled();
  });

  it("refuses to edit while an older settings intent remains queued", async () => {
    mocked.flush.mockResolvedValue(false);
    await expect(saveDiet(["vegetarian"], 4)).rejects.toThrow("Pending profile changes");
    expect(mocked.mutate).not.toHaveBeenCalled();
  });

  it("does not update the phone projection after an account switch", async () => {
    mocked.assert.mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("The account changed"); });
    await expect(saveDiet(["vegetarian"], 4)).rejects.toThrow("account changed");
    expect(mocked.saveStore).not.toHaveBeenCalled();
  });
});
