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
    ({ lines: [] as unknown[], failed: [] as string[], uncertain: [] as string[] })),
  del: vi.fn(async (_line: unknown, _account?: unknown) => undefined),
}));
vi.mock("@/lib/shopping-client", async () => {
  const real = await vi.importActual<typeof import("@/lib/shopping-client")>("@/lib/shopping-client");
  return { shoppingAnswerStatus: real.shoppingAnswerStatus, shoppingRefused: real.shoppingRefused,
    ShoppingRequestFailed: real.ShoppingRequestFailed,
  addToCurrentShoppingList: (names: string[], today: string, tz: string, ids?: string[], account?: unknown) =>
    client.add(names, today, tz, ids, account),
  deleteShoppingLine: (line: unknown, account?: unknown) => client.del(line, account),
  };
});

import { ShoppingRequestFailed } from "@/lib/shopping-client";
import { applyAddToShoppingList, SHOPPING_SWITCH_PARTIAL_REASON, SHOPPING_UNAVAILABLE_REASON,
  undoAddToShoppingList } from "@/lib/coach/apply-shopping";

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
  client.add.mockReset().mockResolvedValue({ lines: LINES, failed: [], uncertain: [] });
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
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [LINES[1]], failed: [], uncertain: [] });
    const result = await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(client.add).toHaveBeenLastCalledWith(["oat milk"], expect.any(String), "America/Denver",
      [expect.any(String)], bound);
    expect(result).toEqual({ status: "applied", token: { kind: "add_to_shopping_list", lines: LINES } });
  });

  it("takes the saved part back and fails when an item still does not save", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
    expect(client.del).toHaveBeenCalledWith(LINES[0], bound);
  });

  it("retries an item under its first request id, so a lost answer cannot add it twice (DeepSeek round 9)",
    async () => {
      client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
        .mockResolvedValueOnce({ lines: [LINES[1]], failed: [], uncertain: [] });
      await applyAddToShoppingList(action, { tz: "America/Denver" });
      const [first, retry] = client.add.mock.calls;
      expect(retry[3]).toEqual([first[3]![1]]);
    });

  it("takes the saved part back when the retry itself throws (DeepSeek round 9)", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockRejectedValueOnce(new Error("offline"));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
    expect(client.del).toHaveBeenCalledWith(LINES[0], bound);
  });
});

describe("applyAddToShoppingList: an account switch part-way (audit 2026-10-08 §4)", () => {
  it("runs the gate, both tries and the rollback as the one account captured at the start", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(access.enabled).toHaveBeenCalledWith(bound);
    expect(client.add.mock.calls.map((call) => call[4])).toEqual([bound, bound]);
    expect(client.del.mock.calls.map((call) => call[1])).toEqual([bound]);
  });

  it("does not retry under the new account: the retry still carries the first account's handle", async () => {
    client.add.mockImplementationOnce(async () => {
      unbindAccount(); bindAccount("other-user");
      return { lines: [LINES[0]], failed: ["oat milk"], uncertain: [] };
    });
    await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(client.add.mock.calls[1]?.[4]).toEqual(bound);
  });

  it("rethrows AccountChanged and rolls nothing back under another account", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockRejectedValueOnce(new AccountChanged());
    await expect(applyAddToShoppingList(action, { tz: "America/Denver" }))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(client.del).not.toHaveBeenCalled();
  });

  it("says when lines saved before the switch stay behind, with no Undo (W020)", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockRejectedValueOnce(new AccountChanged());
    const error = await applyAddToShoppingList(action, { tz: "America/Denver" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountChanged);
    expect((error as Error).message).toBe(SHOPPING_SWITCH_PARTIAL_REASON);
    // No item names: the card may already be in front of the account that took over.
    expect((error as Error).message).not.toMatch(/eggs/);
  });

  it("reports a possible partial add when the switch lands inside the first try", async () => {
    // The try may have saved a line before it threw: its answer is lost, so the card says "may".
    client.add.mockRejectedValueOnce(new AccountChanged());
    const error = await applyAddToShoppingList(action, { tz: "America/Denver" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountChanged);
    expect((error as Error).message).toBe(SHOPPING_SWITCH_PARTIAL_REASON);
    expect(client.del).not.toHaveBeenCalled();
  });

  it("keeps the plain AccountChanged when the switch lands during the access check", async () => {
    access.enabled.mockRejectedValueOnce(new AccountChanged());
    const error = await applyAddToShoppingList(action, { tz: "America/Denver" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountChanged);
    expect((error as Error).message).toBe(new AccountChanged().message);
    expect(client.add).not.toHaveBeenCalled();
  });

  it("rejects when a request fails for another reason after the account switched", async () => {
    // A fetch that rejects after the switch skips accountFetch's own post-answer check: the saved
    // line belongs to the account that left, so nothing is rolled back under the new one.
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockImplementationOnce(async () => {
        unbindAccount(); bindAccount("other-user");
        throw new TypeError("Failed to fetch");
      });
    const error = await applyAddToShoppingList(action, { tz: "America/Denver" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountChanged);
    expect((error as Error).message).toBe(SHOPPING_SWITCH_PARTIAL_REASON);
    expect(client.del).not.toHaveBeenCalled();
  });

  it("names nothing when the switch lands during the rollback", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    client.del.mockRejectedValueOnce(new AccountChanged());
    const error = await applyAddToShoppingList(action, { tz: "America/Denver" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountChanged);
    expect((error as Error).message).toBe(SHOPPING_SWITCH_PARTIAL_REASON);
  });
});

describe("applyAddToShoppingList: a rollback that cannot take every line back (W020)", () => {
  it("names the lines still on the list and says the card cannot undo them", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    client.del.mockRejectedValueOnce(new ShoppingRequestFailed("Too many requests", 429));
    const result = await applyAddToShoppingList(action, { tz: "America/Denver" });
    expect(result).toEqual({ status: "failed",
      reason: "Not every item saved. eggs is still on your list, and this card can't undo it. "
        + "Remove it in Shopping." });
  });

  it("names every line left behind", async () => {
    const three = { ...action, names: ["eggs", "oat milk", "rice"] };
    const rice = { ...LINES[1], id: "l3", name: "rice" };
    client.add.mockResolvedValueOnce({ lines: [LINES[0], rice], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    client.del.mockRejectedValue(new ShoppingRequestFailed("Too many requests", 429));
    const result = await applyAddToShoppingList(three, { tz: "America/Denver" });
    expect(result).toEqual({ status: "failed",
      reason: "Not every item saved. eggs and rice are still on your list, and this card can't undo them. "
        + "Remove them in Shopping." });
  });

  it("says an item may still be on the list when neither try read an answer for it", async () => {
    // The add committed both times but each answer was lost: it may be on the list, with no Undo.
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: ["oat milk"] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: ["oat milk"] });
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" })).toEqual({ status: "failed",
      reason: "Not every item saved. oat milk may still be on your list, and this card can't undo it. "
        + "Check Shopping and remove it there." });
    expect(client.del).toHaveBeenCalledWith(LINES[0], bound);
  });

  it("keeps an unanswered first try as uncertain when the retry cannot run", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: ["oat milk"] })
      .mockRejectedValueOnce(new Error("offline"));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" })).toEqual({ status: "failed",
      reason: "Not every item saved. oat milk may still be on your list, and this card can't undo it. "
        + "Check Shopping and remove it there." });
  });

  it("says a line may still be on the list when its rollback delete read no answer", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    client.del.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" })).toEqual({ status: "failed",
      reason: "Not every item saved. eggs may still be on your list, and this card can't undo it. "
        + "Check Shopping and remove it there." });
  });

  it("names kept and uncertain lines apart", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: ["oat milk"] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: ["oat milk"] });
    client.del.mockRejectedValueOnce(new ShoppingRequestFailed("Too many requests", 429));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" })).toEqual({ status: "failed",
      reason: "Not every item saved. eggs is still on your list, and oat milk may be too. "
        + "This card can't undo them. Check Shopping and remove them there." });
  });

  it("counts a line the route no longer finds (404) as taken back", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    client.del.mockRejectedValueOnce(new ShoppingRequestFailed("Shopping item not found.", 404));
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
  });

  it("keeps the plain retry line when every saved line was taken back", async () => {
    client.add.mockResolvedValueOnce({ lines: [LINES[0]], failed: ["oat milk"], uncertain: [] })
      .mockResolvedValueOnce({ lines: [], failed: ["oat milk"], uncertain: [] });
    expect(await applyAddToShoppingList(action, { tz: "America/Denver" }))
      .toEqual({ status: "failed", reason: "Those items did not save. Try again." });
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
