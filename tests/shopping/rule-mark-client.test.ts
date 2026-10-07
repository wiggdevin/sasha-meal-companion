// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { acceptShopping, addManualShoppingLine, confirmPantryForLine, getShoppingPeriod, listPantry,
  patchShoppingLine, previewShopping } from "@/lib/shopping-client";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import { parseRuleMark } from "@/lib/shopping/rule-mark-wire";
import type { ShoppingLine } from "@/lib/shopping/types";

const blocked = { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." } as const;
const unknown = { verdict: "unknown", reason: "We couldn't check Granola against your food rules." } as const;

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

function serve(...bodies: unknown[]) {
  const send = vi.fn();
  for (const body of bodies) send.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", send);
  return send;
}

describe("parseRuleMark", () => {
  it("keeps a blocked or unknown mark as the server wrote it", () => {
    expect(parseRuleMark(blocked)).toEqual(blocked);
    expect(parseRuleMark(unknown)).toEqual(unknown);
  });

  it("reads a missing or null mark as no mark", () => {
    expect(parseRuleMark(undefined)).toBeNull();
    expect(parseRuleMark(null)).toBeNull();
  });

  it.each([
    ["a string", "blocked"],
    ["an array", [blocked]],
    ["an unknown verdict", { verdict: "allowed", reason: "Fine." }],
    ["a missing reason", { verdict: "blocked" }],
    ["a blank reason", { verdict: "unknown", reason: "   " }],
    ["a non-text reason", { verdict: "blocked", reason: 42 }],
    ["an overlong reason", { verdict: "blocked", reason: "x".repeat(501) }],
  ])("drops %s instead of throwing", (_label, value) => {
    expect(parseRuleMark(value)).toBeNull();
  });
});

describe("shopping client carries ruleMark", () => {
  it("validates every line of a saved list", async () => {
    serve({ period: { id: "p1" }, lines: [
      { id: "a", name: "Peanut butter", ruleMark: blocked },
      { id: "b", name: "Granola", ruleMark: unknown },
      { id: "c", name: "Rice", ruleMark: null },
      { id: "d", name: "Soap" },
      { id: "e", name: "Oats", ruleMark: { verdict: "maybe", reason: 3 } },
    ] });
    const { lines } = await getShoppingPeriod("p1");
    expect(lines.map((line) => line.ruleMark)).toEqual([blocked, unknown, null, null, null]);
    expect(lines.map((line) => line.name)).toEqual(["Peanut butter", "Granola", "Rice", "Soap", "Oats"]);
  });

  it("returns the mark from a line edit, so a renamed item shows its new mark", async () => {
    serve({ line: { id: "l1", periodId: "p1", name: "Peanut butter", revision: 5, ruleMark: blocked } });
    const saved = await patchShoppingLine({ id: "l1", periodId: "p1", revision: 4, ruleMark: null } as ShoppingLine,
      { name: "Peanut butter" });
    expect(saved.ruleMark).toEqual(blocked);
  });

  it("returns the mark on a new manual line, and drops a malformed one", async () => {
    serve({ line: { id: "m1", name: "Peanut butter", ruleMark: blocked } },
      { line: { id: "m2", name: "Tahini", ruleMark: "blocked" } });
    expect((await addManualShoppingLine("p1", "Peanut butter", "r1")).ruleMark).toEqual(blocked);
    expect((await addManualShoppingLine("p1", "Tahini", "r2")).ruleMark).toBeNull();
  });

  it("validates preview and accept lines", async () => {
    serve({ previewId: "pv", lines: [{ id: "a", ruleMark: unknown }, { id: "b", ruleMark: { verdict: "blocked" } }] },
      { period: null, lines: [{ id: "a", ruleMark: blocked }] });
    const preview = await previewShopping({ draft: defaultShoppingDraft("2026-10-05", "UTC"), basket: [] }, null);
    expect(preview.lines.map((line) => line.ruleMark)).toEqual([unknown, null]);
    expect(preview.previewId).toBe("pv");
    const accepted = await acceptShopping("pv", "req");
    expect(accepted.lines[0].ruleMark).toEqual(blocked);
  });

  it("validates pantry items on read and on confirm", async () => {
    const identity = { foodRefId: "f1", catalogFoodRevisionId: 1, purchaseState: "raw", variantKey: "plain" } as const;
    serve({ items: [{ id: "i1", name: "Peanut butter", identity, ruleMark: blocked }, { id: "i2", name: "Rice", identity }] });
    expect((await listPantry()).map((item) => item.ruleMark)).toEqual([blocked, null]);
    serve({ items: [] }, { item: { id: "i3", name: "Granola", identity, ruleMark: unknown } });
    const saved = await confirmPantryForLine({ id: "l1", name: "Granola", identity } as ShoppingLine, 200);
    expect(saved.ruleMark).toEqual(unknown);
  });
});
