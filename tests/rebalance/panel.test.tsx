/**
 * Phase 19 R2 / §7: the panel component — one "View meal" link per card kind, no action list, the
 * missed label is the panel's own, and "View meal" reaches the right Today card.
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RebalancePanel from "@/components/today/RebalancePanel";
import type { RebalancePanel as RebalancePanelData, RebalancePanelCard } from "@/lib/rebalance/panel";
import { openSlotCard } from "@/lib/today/open-slot-card";
import SlotCard from "@/components/SlotCard";
import type { ResolvedSlot } from "@/lib/types";

afterEach(cleanup);

const card = (overrides: Partial<RebalancePanelCard>): RebalancePanelCard => ({
  slot: "meal-1", label: "Breakfast", time: "08:00", kcal: 500, status: "remaining", highlight: false,
  ...overrides,
});

function panelOf(cards: RebalancePanelCard[]): Extract<RebalancePanelData, { show: true }> {
  return {
    show: true, state: "under", tone: "nudge", copyKey: "under",
    numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 1800,
      intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
      proteinTargetG: 120, proteinConsumedG: 25 },
    cards,
  };
}

describe("one link per card kind", () => {
  it.each([
    ["missed", card({ slot: "meal-1", label: "Breakfast", status: "missed" })],
    ["remaining with a meal", card({ slot: "meal-2", label: "Lunch", status: "remaining" })],
    ["remaining empty", card({ slot: "meal-3", label: "Dinner", status: "remaining", kcal: 0 })],
    ["remaining with food logged under it", card({ slot: "meal-4", label: "Snack", status: "remaining" })],
  ])("%s renders exactly one View meal link, calling onOpenSlot once with its slot", (_kind, one) => {
    const onOpenSlot = vi.fn();
    render(<RebalancePanel panel={panelOf([one])} onOpenSlot={onOpenSlot} />);
    const row = within(screen.getByRole("list")).getByText(
      one.status === "missed" ? `${one.label} went by` : one.label,
    ).closest("li")!;
    const links = within(row).getAllByRole("button", { name: /view meal/i });
    expect(links).toHaveLength(1);
    links[0].click();
    expect(onOpenSlot).toHaveBeenCalledTimes(1);
    expect(onOpenSlot).toHaveBeenCalledWith(one.slot);
  });
});

describe("no action list", () => {
  it("the contract has no actions array, for any card kind", () => {
    const panel = panelOf([card({ status: "missed" }), card({ status: "remaining" })]);
    for (const one of panel.cards) expect("actions" in one).toBe(false);
    expect("actions" in panel).toBe(false);
  });

  it("renders only a headline, its sub lines and the card rows — no other control", () => {
    const panel = panelOf([card({})]);
    render(<RebalancePanel panel={panel} onOpenSlot={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["View meal"]);
  });
});

describe("missed label is the panel's own", () => {
  it("renders '<label> went by' for a missed card, from the card's status alone", () => {
    // A different label than the one the "under" copy might also name, so the card row's own
    // text is unambiguous from the headline/sub block above it.
    const panel = panelOf([card({ slot: "meal-2", label: "Dinner", status: "missed" })]);
    render(<RebalancePanel panel={panel} onOpenSlot={() => {}} />);
    const row = within(screen.getByRole("list")).getByText("Dinner went by").closest("li")!;
    expect(row.getAttribute("data-rebalance-card")).toBe("meal-2");
  });

  it("never labels a remaining card as missed", () => {
    const panel = panelOf([card({ slot: "meal-2", label: "Dinner", status: "remaining" })]);
    render(<RebalancePanel panel={panel} onOpenSlot={() => {}} />);
    expect(within(screen.getByRole("list")).queryByText("Dinner went by")).toBeNull();
    expect(within(screen.getByRole("list")).getByText("Dinner")).toBeTruthy();
  });
});

describe("hidden and headline text", () => {
  it("renders nothing when show is false", () => {
    const { container } = render(<RebalancePanel panel={{ show: false }} onOpenSlot={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("colours the kcal figures through KcalText, as plain text otherwise", () => {
    const { container } = render(<RebalancePanel panel={panelOf([])} onOpenSlot={() => {}} />);
    expect(container.textContent).toContain("1500 kcal left today");
    const figure = container.querySelector(".kcal");
    expect(figure?.textContent).toBe("1500");
  });
});

const EMPTY_STANDARD: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Lunch", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};
const EMPTY_FOCUS: ResolvedSlot = {
  slot: "meal-1", time: "08:00", label: "Breakfast", meal: null, components: [],
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false,
};

describe("onOpenSlot reaches the right Today card", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("scrolls to and focuses an empty standard card", () => {
    render(<SlotCard slot={EMPTY_STANDARD} variant="standard" canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} />);
    openSlotCard("meal-2");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Plan");
  });

  it("scrolls to and focuses an empty focus card", () => {
    render(<SlotCard slot={EMPTY_FOCUS} variant="focus" canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} />);
    openSlotCard("meal-1");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Plan with Sasha");
  });

  it("does nothing when the slot has no card on screen", () => {
    render(<SlotCard slot={EMPTY_STANDARD} variant="standard" canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} />);
    expect(() => openSlotCard("meal-5")).not.toThrow();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
