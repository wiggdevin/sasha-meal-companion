// @vitest-environment jsdom
/**
 * `add_to_shopping_list`'s apply and Undo (owner ask 2026-10-02). The write itself —
 * `addToCurrentShoppingList` finding or creating this week's list — is tested against the real
 * client in tests/shopping/ui-client.test.ts; this covers the binding: the access gate, the date
 * it hands the write, and Undo deleting every line it created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const access = vi.hoisted(() => ({ enabled: vi.fn(async (_account?: unknown) => true) }));
vi.mock("@/lib/recipe-access-client", () => ({
  recipeAccessForCurrentAccount: (account?: unknown) => access.enabled(account),
}));

const client = vi.hoisted(() => ({
  add: vi.fn(async (_names: string[], _today: string, _tz: string, _ids?: string[], _account?: unknown) =>
    ({ lines: [] as unknown[], failed: [] as string[] })),
  del: vi.fn(async (_line: unknown, _account?: unknown) => undefined),
}));
vi.mock("@/lib/shopping-client", () => ({
  addToCurrentShoppingList: (names: string[], today: string, tz: string, ids?: string[], account?: unknown) =>
    client.add(names, today, tz, ids, account),
  deleteShoppingLine: (line: unknown, account?: unknown) => client.del(line, account),
}));

import { applyAddToShoppingList, SHOPPING_UNAVAILABLE_REASON, undoAddToShoppingList }
  from "@/lib/coach/apply-shopping";

const action = { kind: "add_to_shopping_list" as const, names: ["eggs", "oat milk"],
  actionId: "a1", flagged: [] as string[] };

const LINES = [
  { id: "l1", periodId: "p1", origin: "manual" as const, name: "eggs", identity: null,
    category: "manual" as const, needGrams: null, confirmedStockGrams: null, buyGrams: null,
    packageGrams: null, purchaseConversionStatus: "unknown" as const, sources: [], pinned: false,
    checked: false, note: null, revision: 1 },
  { id: "l2", periodId: "p1", origin: "manual" as const, name: "oat milk", identity: null,
    category: "manual" as const, needGrams: null, confirmedStockGrams: null, buyGrams: null,
    packageGrams: null, purchaseConversionStatus: "unknown" as const, sources: [], pinned: false,
    checked: false, note: null, revision: 1 },
];

let bound: AccountHandle;
beforeEach(() => {
  unbindAccount();
  bound = bindAccount(TEST_USER);
  access.enabled.mockReset().mockResolvedValue(true);
  client.add.mockReset().mockResolvedValue({ lines: LINES, failed: [] });
  client.del.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { unbindAccount(); });

describe("applyAddToShoppingList", () => {
  it("fails with a clear reason, and writes nothing, when Shopping is not available", async () => {
    access.enabled.mockResolvedValue(false);
    const result = await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(result).toEqual({ status: "failed", reason: SHOPPING_UNAVAILABLE_REASON });
    expect(client.add).not.toHaveBeenCalled();
  });

  it("adds every named item to the list covering today, in the account's timezone", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const result = await applyAddToShoppingList(action, { tz: "America/Denver", now });
    expect(client.add).toHaveBeenCalledWith(["eggs", "oat milk"], "2026-10-02", "America/Denver",
      [expect.any(String), expect.any(String)], bound);
    expect(result).toEqual({ status: "applied",
      token: { kind: "add_to_shopping_list", lines: LINES } });
  });
});

describe("applyAddToShoppingList: a partial add", () => {
  it("retries what failed once and keeps one Undo for everything", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
      .mockResolvedValueOnce({ lines: [LINES[1]], failed: [] });
    const result = await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(client.add).toHaveBeenLastCalledWith(["oat milk"], expect.any(String), "America/Denver",
      [expect.any(String)], bound);
    expect(result).toEqual({ status: "applied", token: { kind: "add_to_shopping_list", lines: LINES } });
  });

  it("takes the saved part back and fails when an item still does not save", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"] });
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
    expect(client.del).toHaveBeenCalledWith(LINES[0], bound);
  });

  it("retries an item under its first request id, so a lost answer cannot add it twice (DeepSeek round 9)",
    async () => {
      client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
        .mockResolvedValueOnce({ lines: [LINES[1]], failed: [] });
      await applyAddToShoppingList(action, { tz: "America/Denver" });
      const [first, retry] = client.add.mock.calls;
      expect(retry[3]).toEqual([first[3]![1]]);
    });

  it("takes the saved part back when the retry itself throws (DeepSeek round 9)", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
      .mockRejectedValueOnce(new Error("offline"));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
    expect(client.del).toHaveBeenCalledWith(LINES[0], bound);
  });
});

describe("applyAddToShoppingList: an account switch part-way (audit 2026-10-08 §4)", () => {
  it("runs the gate, both tries and the rollback as the one account captured at the start", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"] });
    await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(access.enabled).toHaveBeenCalledWith(bound);
    expect(client.add.mock.calls.map((call) => call[4])).toEqual([bound, bound]);
    expect(client.del.mock.calls.map((call) => call[1])).toEqual([bound]);
  });

  it("does not retry under the new account: the retry still carries the first account's handle", async () => {
    client.add.mockImplementationOnce(async () => {
      unbindAccount(); bindAccount("other-user");
      return { lines: [LINES[0]], failed: ["oat milk"] };
    });
    await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(client.add.mock.calls[1]?.[4]).toEqual(bound);
  });

  it("rethrows AccountChanged and rolls nothing back under another account", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"] })
      .mockRejectedValueOnce(new AccountChanged());
    await expect(applyAddToShoppingList(action, { tz: "America/Denver" }))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe("undoAddToShoppingList", () => {
  it("deletes every line the action created", async () => {
    await undoAddToShoppingList({ kind: "add_to_shopping_list", lines: LINES });
    expect(client.del).toHaveBeenCalledTimes(2);
    expect(client.del).toHaveBeenCalledWith(LINES[0], undefined);
    expect(client.del).toHaveBeenCalledWith(LINES[1], undefined);
  });

  it("does nothing, and throws nothing, when the action created no lines", async () => {
    await expect(undoAddToShoppingList({ kind: "add_to_shopping_list", lines: [] }))
      .resolves.toBeUndefined();
    expect(client.del).not.toHaveBeenCalled();
  });
});
