// @vitest-environment jsdom
import { listAsText } from "@/lib/shopping/quick-add";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import ShoppingRow from "@/components/ShoppingRow";
import ShoppingView from "@/components/ShoppingView";
import ShoppingPreview from "@/components/ShoppingPreview";
import ShoppingPurchaseWindowCard from "@/components/ShoppingPurchaseWindowCard";
import ShoppingIngredientPicker from "@/components/ShoppingIngredientPicker";
import { listRuleMark } from "@/components/today/ShoppingTodayCard";
import ShoppingTodayCard from "@/components/today/ShoppingTodayCard";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import type { PantryItem, ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";
import type { RuleMark } from "@/lib/types";
import { TEST_USER } from "@/tests/helpers/account";

vi.mock("@/lib/favorites-client", () => ({ listFavorites: vi.fn().mockResolvedValue([]) }));

const blocked: RuleMark = { verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." };
const unknown: RuleMark = { verdict: "unknown", reason: "We couldn't check Granola against your food rules." };
const draft = defaultShoppingDraft("2026-09-27", "America/Denver");
const period: ShoppingPeriod = { id: "p1", userId: "u1", ...draft, planRevision: 1, revision: 1 };
const identity = { foodRefId: "f1", catalogFoodRevisionId: 1, purchaseState: "raw", variantKey: "plain" } as const;
function line(over: Partial<ShoppingLine> = {}): ShoppingLine {
  return { id: "l1", periodId: "p1", origin: "manual", name: "Peanut butter", identity: null,
    category: "manual", needGrams: null, confirmedStockGrams: null, buyGrams: null, packageGrams: null,
    purchaseConversionStatus: "unknown", sources: [], pinned: false, checked: false, note: null,
    revision: 1, ruleMark: null, ...over };
}
function pantryItem(over: Partial<PantryItem> = {}): PantryItem {
  return { id: "i1", userId: "u1", name: "Peanut butter", identity, confirmedGrams: 300,
    confirmedAt: "2026-10-01T00:00:00Z", revision: 1, ruleMark: null, ...over };
}
const viewActions = () => ({ preview: vi.fn(), patchLine: vi.fn().mockResolvedValue(undefined),
  confirmPantry: vi.fn().mockResolvedValue(undefined), addItems: vi.fn().mockResolvedValue(undefined),
  removeLine: vi.fn().mockResolvedValue(undefined), removePantry: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => { unbindAccount(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); unbindAccount(); });

function renderRow(ruleMark: RuleMark | null) {
  return render(<ul><ShoppingRow line={line({ ruleMark, note: "smooth" })} checked={false} onToggle={vi.fn()} /></ul>);
}

describe("shopping row", () => {
  it("tags a blocked item, keeps it on the list, and says the reason once, in the checkbox's name", () => {
    const { container } = renderRow(blocked);
    const row = screen.getByRole("checkbox", { name: `Peanut butter, to buy. Off your rules: ${blocked.reason}` });
    expect(within(row).getByText("Off your rules")).toBeTruthy();
    expect(within(row).getByText("smooth")).toBeTruthy();
    expect(row.getAttribute("aria-describedby")).toBeNull();
    // The only copy of the reason outside the named checkbox would be a second announcement.
    const outside = [...container.querySelectorAll(".sr-only")].filter((el) => !row.contains(el));
    expect(outside.map((el) => el.textContent)).not.toContain(`Off your rules: ${blocked.reason}`);
  });

  it("asks to check an unknown item", () => {
    renderRow(unknown);
    const row = screen.getByRole("checkbox", { name: `Peanut butter, to buy. Check: ${unknown.reason}` });
    expect(within(row).getByText("Check")).toBeTruthy();
    expect(row.querySelector("[data-rule-mark='unknown']")?.getAttribute("title")).toBe(unknown.reason);
  });

  it("shows no tag and no description without a mark", () => {
    const { container } = renderRow(null);
    expect(container.querySelector("[data-rule-mark]")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Peanut butter, to buy" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("shows the full sentence in the item's details", () => {
    renderRow(blocked);
    fireEvent.click(screen.getByRole("button", { name: "Details for Peanut butter" }));
    expect(screen.getByText(blocked.reason)).toBeTruthy();
  });
});

describe("shopping view", () => {
  it("marks pantry items with the reason and still lets them be removed", () => {
    render(<ShoppingView period={period} lines={[]} initialDraft={draft} actions={viewActions()}
      pantry={[pantryItem({ ruleMark: blocked }), pantryItem({ id: "i2", name: "Rice", ruleMark: null })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Have already/ }));
    const marked = screen.getByRole("button", { name: "Remove Peanut butter from Have already" }).closest("li")!;
    const clear = screen.getByRole("button", { name: "Remove Rice from Have already" }).closest("li")!;
    expect(within(marked).getByText("Off your rules")).toBeTruthy();
    expect(within(marked).getByText(blocked.reason)).toBeTruthy();
    expect(clear.querySelector("[data-rule-mark]")).toBeNull();
  });
});

describe("shopping preview", () => {
  it("shows the mark on added and changed lines", () => {
    const current = [line({ id: "c1", origin: "plan", category: "core", name: "Granola", identity,
      needGrams: 100, buyGrams: 100 })];
    const next = [line({ id: "c1", origin: "plan", category: "core", name: "Granola", identity,
      needGrams: 200, buyGrams: 200, ruleMark: unknown }),
    line({ id: "n1", origin: "plan", category: "core", identity: { ...identity, foodRefId: "f2" },
      needGrams: 50, buyGrams: 50, ruleMark: blocked }),
    line({ id: "n2", origin: "plan", category: "core", name: "Rice", identity: { ...identity, foodRefId: "f3" },
      needGrams: 50, buyGrams: 50 })];
    render(<ShoppingPreview current={current} preview={{ period, lines: next, issues: [], unmetPins: [],
      accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(blocked.reason)).toBeTruthy();
    expect(screen.getByText(unknown.reason)).toBeTruthy();
    expect(screen.getAllByText("Off your rules")).toHaveLength(1);
    expect(screen.getAllByText("Check")).toHaveLength(1);
  });

  it("counts a line whose mark changed as a change, even with the same amounts", () => {
    const base = { origin: "plan" as const, category: "core" as const, needGrams: 100, buyGrams: 100 };
    const current = [line({ ...base, id: "c1", name: "Granola", identity }),
      line({ ...base, id: "c2", name: "Rice", identity: { ...identity, foodRefId: "f3" }, ruleMark: unknown })];
    const next = [line({ ...base, id: "c1", name: "Granola", identity, ruleMark: blocked }),
      line({ ...base, id: "c2", name: "Rice", identity: { ...identity, foodRefId: "f3" } })];
    render(<ShoppingPreview current={current} preview={{ period, lines: next, issues: [], unmetPins: [],
      accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Change 2")).toBeTruthy();
    const changed = screen.getByRole("heading", { name: "Changed" }).parentElement!;
    expect(within(changed).getByText(blocked.reason)).toBeTruthy();
    expect(within(changed).getByText(/Granola · 100 g to buy/).textContent).not.toContain("→");
    expect(within(changed).getByText(/Rice · 100 g to buy · no longer marked against your food rules/)).toBeTruthy();
  });

  it("leaves a line with the same amounts and the same mark out of the changes", () => {
    const same = line({ origin: "plan", category: "core", identity, needGrams: 100, buyGrams: 100, ruleMark: blocked });
    render(<ShoppingPreview current={[same]} preview={{ period, lines: [{ ...same }], issues: [], unmetPins: [],
      accept: vi.fn() }} onAccepted={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Change 0")).toBeTruthy();
  });
});

describe("purchase window card", () => {
  it("shows the line's mark beside its week", () => {
    render(<ShoppingPurchaseWindowCard line={line({ ruleMark: blocked })} onPatch={vi.fn()}
      window={{ id: "w1", periodId: "p1", lineId: "l1", windowStartDate: "2026-10-01", windowEndDate: "2026-10-07",
        needGrams: 100, confirmedStockGrams: null, buyGrams: 100, checked: false, note: null, revision: 1 }} />);
    expect(screen.getByText("Off your rules")).toBeTruthy();
    expect(screen.getByText(blocked.reason)).toBeTruthy();
  });
});

describe("ingredient picker", () => {
  it("tags list and pantry options that carry a mark", () => {
    render(<ShoppingIngredientPicker selected={[]} onChange={vi.fn()}
      lines={[line({ name: "Granola", identity, ruleMark: unknown })]}
      pantry={[pantryItem({ identity: { ...identity, foodRefId: "f9" }, ruleMark: blocked })]} />);
    expect(screen.getByText("Check")).toBeTruthy();
    expect(screen.getByText("Off your rules")).toBeTruthy();
  });
});

describe("copied list", () => {
  it("keeps a line's mark in the text that leaves the app", () => {
    const text = listAsText("This week", [line({ ruleMark: blocked }), line({ id: "l2", name: "Eggs" })]);
    expect(text).toContain(`☐ Peanut butter`);
    expect(text).toContain(`(Off your rules: ${blocked.reason})`);
    expect(text).toMatch(/☐ Eggs(?! \()/);
  });

  it("keeps the mark on a line already in the cart", () => {
    const text = listAsText("This week", [line({ checked: true, ruleMark: unknown }), line({ id: "l2", name: "Eggs", checked: true })]);
    expect(text).toContain(`☑ Peanut butter (Check: ${unknown.reason})`);
    expect(text).toMatch(/☑ Eggs$/);
  });
});

describe("today card", () => {
  it("summarises marks on open items, blocked first", () => {
    expect(listRuleMark([line()])).toBeNull();
    expect(listRuleMark([line({ ruleMark: unknown }), line()])).toEqual(unknown);
    expect(listRuleMark([line({ ruleMark: unknown }), line({ ruleMark: blocked })])).toEqual({
      verdict: "blocked", reason: "1 item off your food rules, 1 item to check." });
    expect(listRuleMark([line({ ruleMark: unknown }), line({ ruleMark: unknown })])).toEqual({
      verdict: "unknown", reason: "2 items to check." });
    expect(listRuleMark([line({ ruleMark: blocked }), line({ ruleMark: blocked })])).toEqual({
      verdict: "blocked", reason: "2 items off your food rules." });
  });

  it("tags the card when an open item is marked", async () => {
    bindAccount(TEST_USER);
    const covering = { id: "p1", startDate: "2026-09-30", endDate: "2026-10-06", revision: 1 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/shopping/periods/p1")
      ? new Response(JSON.stringify({ period: covering, lines: [
        { id: "a", name: "Peanut butter", checked: false, ruleMark: blocked },
        { id: "b", name: "Eggs", checked: false, ruleMark: { verdict: "nope" } }] }), { status: 200 })
      : new Response(JSON.stringify({ periods: [covering] }), { status: 200 })));
    render(<ShoppingTodayCard enabled today="2026-10-02" />);
    expect(await screen.findByText("2 to buy")).toBeTruthy();
    const tag = screen.getByText("Off your rules").closest("[data-rule-mark]");
    expect(tag?.getAttribute("title")).toBe(blocked.reason);
    // The sentence is on screen too, not only in the tag's title.
    expect(screen.getAllByText(blocked.reason).some((el) => !el.classList.contains("sr-only"))).toBe(true);
  });
});

describe("ingredient picker merge", () => {
  it("keeps a pantry item's blocked mark when a list line shares its identity", () => {
    render(<ShoppingIngredientPicker selected={[]} onChange={vi.fn()}
      lines={[line({ name: "Granola", identity, ruleMark: null })]}
      pantry={[pantryItem({ name: "Granola, honey", identity, ruleMark: blocked })]} />);
    expect(screen.getByText("Off your rules")).toBeTruthy();
  });
});
