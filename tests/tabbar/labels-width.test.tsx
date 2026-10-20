import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TabBar, { tabBarLayout, tabSlots } from "@/components/TabBar";
import { TABS } from "@/components/dock/TabCapsule";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/body"),
  useRouter: () => ({ push: vi.fn() }),
}));

/** The capsule's width at a viewport: 16 px gutters, the bubble and the split come off the row. */
const capsuleAt = (viewport: number) => viewport - 32 - 10 - 64;

describe("the dock labels every tab at every width", () => {
  const markup = renderToStaticMarkup(<TabBar />);

  it("prints all four labels and marks the current one", () => {
    for (const tab of TABS) expect(markup).toContain(`>${tab.label}</span>`);
    expect((markup.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it.each([320, 390])("fits four equal slots inside the capsule at %i px", (viewport) => {
    const width = capsuleAt(viewport);
    const gap = tabBarLayout(viewport, TABS.length).compact ? 2 : 4;
    const slots = tabSlots(width, TABS.length, gap);
    expect(slots).toHaveLength(4);
    for (const slot of slots) expect(slot.w).toBeGreaterThanOrEqual(44);
    const last = slots[slots.length - 1];
    expect(last.x + last.w).toBeLessThanOrEqual(width);
    expect(new Set(slots.map((slot) => Math.round(slot.w))).size).toBe(1);
  });

  it("tightens padding, not labels, below 360 px", () => {
    expect(tabBarLayout(320, 4).compact).toBe(true);
    expect(tabBarLayout(390, 4).compact).toBe(false);
  });
});
