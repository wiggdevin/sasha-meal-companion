// @vitest-environment jsdom
/**
 * The companion row in the Overview face (UI makeover §5, W3): one 64 px row that opens in place,
 * the Seeds tag only when the care read answered, the pond, and Hide with Undo through the slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import CompanionCard from "./CompanionCard";
import CompanionSlot from "./CompanionSlot";
import type { OverviewData } from "./types";

const care = vi.hoisted(() => ({ shop: "failed" as unknown, reads: 0 }));
vi.mock("@/components/today/care/care-api", async (original) => ({
  ...(await original<typeof import("@/components/today/care/care-api")>()),
  readCareShop: async () => { care.reads += 1; return care.shop; },
  readCareMessages: async () => [],
}));
vi.mock("@/components/today/care/sound", () => ({
  play: vi.fn(), unlockAudio: vi.fn(), readMuted: () => true, silence: vi.fn(), writeMuted: vi.fn(),
}));
const shown = vi.hoisted(() => ({ hidden: [] as string[], writes: [] as [string, boolean][], fail: false }));
vi.mock("@/lib/today/companion-visibility", () => ({
  useCompanionShown: (key: string) => !shown.hidden.includes(key),
  setCompanionShown: async (key: string, next: boolean) => {
    shown.writes.push([key, next]);
    if (shown.fail) throw new Error("offline");
    shown.hidden = next ? shown.hidden.filter((k) => k !== key) : [...shown.hidden, key];
  },
}));
vi.mock("@/components/today/island/well-pet", async (original) => ({
  ...(await original<typeof import("@/components/today/island/well-pet")>()),
  useMascot: () => "blueberry",
}));

const SHOP = { state: { balance: 12, owned: [], equipped: {}, rev: 1, ledger: [], items: [] }, prices: {} };
const DATA: OverviewData = {
  date: "2026-10-19", today: "2026-10-19", when: "today",
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 }, consumed: { kcal: 1200, protein: 90, carbs: 80, fat: 30 },
  partial: false, water: { cups: 4, goal: 8 }, next: null, planned: 3,
};

beforeEach(() => {
  window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn();
  care.shop = "failed"; care.reads = 0; shown.hidden = []; shown.writes = []; shown.fail = false;
});
afterEach(cleanup);

const mount = (node: React.ReactNode) => render(<MotionConfig reducedMotion="always">{node}</MotionConfig>);
const row = () => screen.getByRole("button", { name: /^Blu: (content|joyful|sleepy)\. (Open|Close)$/ });

describe("CompanionCard", () => {
  it("collapsed: one row with the companion, its line and a chevron, closed, and no Seeds tag when the read fails", async () => {
    mount(<CompanionCard data={DATA} mascot="blueberry" active preview={{ hour: 13 }} />);
    expect(row().getAttribute("aria-expanded")).toBe("false");
    expect(row().textContent).toContain("Blu");
    expect(screen.queryByTestId("companion-seeds")).toBeNull();
    // A design preview reads nothing.
    expect(care.reads).toBe(0);
  });

  it("collapsed with Seeds: the tag shows once the care read answers, on today only", async () => {
    care.shop = SHOP;
    const { unmount } = mount(<CompanionCard data={DATA} mascot="blueberry" active />);
    await waitFor(() => expect(screen.getByTestId("companion-seeds").textContent).toBe("Seeds 12"));
    unmount();
    care.reads = 0;
    mount(<CompanionCard data={{ ...DATA, when: "past" }} mascot="blueberry" active />);
    expect(care.reads).toBe(0);
    expect(screen.queryByTestId("companion-seeds")).toBeNull();
  });

  it("open: the stage with the companion, its line and Care today, then Visit the pond and Hide", () => {
    const onHide = vi.fn();
    mount(<CompanionCard data={DATA} mascot="blueberry" active onHide={onHide} preview={{ hour: 13 }} />);
    fireEvent.click(row());
    expect(row().getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(row().getAttribute("aria-controls")!)!;
    expect(within(panel).getByRole("button", { name: "Blu. Say hello" })).toBeTruthy();
    expect(within(panel).getByRole("meter", { name: "Blu's wellbeing" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Visit the pond" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Hide Blu" }));
    expect(onHide).toHaveBeenCalled();
  });

  it("the pond swaps the stage, and Back brings the stage back", () => {
    mount(<CompanionCard data={DATA} mascot="blueberry" active preview={{ hour: 13, open: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Visit the pond" }));
    expect(screen.queryByRole("button", { name: "Blu. Say hello" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Blu. Say hello" })).toBeTruthy();
  });

  it("without targets: no pond and no care meter, nothing invented", () => {
    mount(<CompanionCard data={{ ...DATA, targets: null }} mascot="blueberry" active preview={{ hour: 13, open: true }} />);
    expect(screen.getAllByText("Blu is here with you.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Visit the pond" })).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});

describe("CompanionSlot", () => {
  it("hidden: renders nothing and reads no care", () => {
    shown.hidden = ["blueberry"];
    const { container } = mount(<CompanionSlot data={DATA} active />);
    expect(container.textContent).toBe("");
    expect(care.reads).toBe(0);
  });

  it("Hide hides the companion for the account and offers Undo, which shows it again", async () => {
    const { rerender } = mount(<CompanionSlot data={DATA} active />);
    fireEvent.click(row());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide Blu" })); });
    expect(shown.writes).toEqual([["blueberry", false]]);
    rerender(<MotionConfig reducedMotion="always"><CompanionSlot data={DATA} active /></MotionConfig>);
    expect(screen.queryByRole("button", { name: /^Blu:/ })).toBeNull();
    expect(screen.getByText("Blu is hidden. Show it again in Settings.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(shown.writes).toEqual([["blueberry", false], ["blueberry", true]]);
    rerender(<MotionConfig reducedMotion="always"><CompanionSlot data={DATA} active /></MotionConfig>);
    expect(row()).toBeTruthy();
  });

  it("a Hide that fails says so and keeps the companion", async () => {
    shown.fail = true;
    mount(<CompanionSlot data={DATA} active />);
    fireEvent.click(row());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide Blu" })); });
    expect(screen.getByText("Couldn't hide Blu. Try again.")).toBeTruthy();
    expect(row()).toBeTruthy();
  });
});
