// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import HealthOrbit from "@/components/HealthOrbit";
import { orbitGeometry } from "@/lib/today/orbit-geometry";
import { MAX_CUPS, PX_PER_CUP } from "@/lib/today/water-gesture";
import type { OrbitBody } from "@/lib/today/health-orbit";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { Macros } from "@/lib/types";

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const ROW: DailyHealthRow = {
  local_date: "2026-09-30", steps: 8012, active_kcal: 412, sleep_minutes: 444, body_mass_kg: null,
  sources: [], resting_heart_rate: null, hrv_sdnn: null, readiness_score: 82, provenance: {},
};
const ready: OrbitBody = { capability: "enabled", loading: false, row: ROW, offline: false, fetchedAt: null };

// Motion measures an "auto" height and restores the scroll position; jsdom has no scrollTo.
beforeEach(() => { window.scrollTo = () => {}; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mount(props: Partial<Parameters<typeof HealthOrbit>[0]> = {}, reduced = false) {
  const onAddCup = vi.fn();
  const onSetCups = vi.fn();
  const orbit = <HealthOrbit targets={targets} consumed={consumed} water={{ cups: 3, goal: 8 }}
    onAddCup={onAddCup} onSetCups={onSetCups} body={ready} {...props} />;
  const utils = render(reduced ? <MotionConfig reducedMotion="always">{orbit}</MotionConfig> : orbit);
  return { ...utils, onAddCup, onSetCups };
}
const opener = () => screen.getByRole("button", { name: "Open health overview" });
const closer = () => screen.getByRole("button", { name: "Close health overview" });
const back = () => screen.getByRole("button", { name: /back to health overview/i });
const ring = () => screen.queryByRole("group", { name: "Today's health metrics" });
const metric = (name: RegExp) => screen.getByRole("button", { name });
const stageOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-orbit-stage]")!;
async function openMetric(name: RegExp) {
  fireEvent.click(opener());
  fireEvent.click(metric(name));
  return screen.findByRole("region", { name: /detail/i });
}
async function expectOverview() {
  await waitFor(() => expect(screen.queryByRole("region", { name: /detail/i })).toBeNull());
  await waitFor(() => expect(within(ring()!).getAllByRole("button")).toHaveLength(7));
  expect(closer().getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("button", { name: /back to health overview/i })).toBeNull();
}

describe("HealthOrbit · closed", () => {
  it("is one accessible orb button with no visible word, number or ring", () => {
    const { container } = mount();
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/overview/i);
    expect(container.textContent).not.toMatch(/\d/);
    expect(ring()).toBeNull();
    expect(container.querySelectorAll("canvas").length).toBeLessThanOrEqual(1);
  });
});

describe("HealthOrbit · open", () => {
  it("expands seven labelled metric nodes with their current amounts", () => {
    mount();
    fireEvent.click(opener());
    expect(closer().getAttribute("aria-expanded")).toBe("true");
    const nodes = within(ring()!).getAllByRole("button");
    expect(nodes).toHaveLength(7);
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual([
      "Calories eaten: 1,200 of 2,000 kcal",
      "Carbohydrates: 80 of 200 g",
      "Protein: 90 of 150 g",
      "Fat: 30 of 70 g",
      "Water: 3 of 8 cups",
      "Active burn: 412 kcal",
      "Sleep and recovery: 7h 24m",
    ]);
    expect(nodes[0].textContent).toContain("1,200 kcal");
    expect(nodes[0].textContent).toContain("Eaten");
    expect(nodes[5].textContent).toContain("412 kcal");
    expect(nodes[5].textContent).toContain("Active");
  });

  it("turns the open constellation slowly clockwise", async () => {
    mount();
    fireEvent.click(opener());
    const turn = () => Number(/rotate\((-?[\d.]+)deg\)/.exec(ring()!.style.transform)?.[1] ?? 0);
    await waitFor(() => expect(turn()).toBeGreaterThan(0), { timeout: 1500 });
  });

  it("selecting a node swaps the ring for a fixed detail with a large back entity, in the same stage", async () => {
    const { container } = mount();
    fireEvent.click(opener());
    const stage = stageOf(container);
    const openHeight = `${orbitGeometry(null).height}px`;
    await waitFor(() => expect(stage.style.height).toBe(openHeight));

    fireEvent.click(metric(/^Calories eaten/));
    const panel = await screen.findByRole("region", { name: /detail/i });
    await waitFor(() => expect(ring()).toBeNull());
    expect(back()).toBeTruthy();
    // The overview orb is not the back control while a detail is shown.
    expect(screen.queryByRole("button", { name: /close health overview/i })).toBeNull();
    expect(panel.textContent).toContain("1,200 kcal");
    expect(panel.textContent).toContain("2,000 kcal");
    expect(panel.textContent).toContain("800 kcal left");
    expect(screen.getByText("Calories eaten selected")).toBeTruthy();
    expect(stage.style.height).toBe(openHeight);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stage.style.height).toBe(openHeight);
  });

  it("pressing the large entity returns to the open seven-node overview, then the orb closes it", async () => {
    mount();
    await openMetric(/^Fat/);
    fireEvent.click(back());
    await expectOverview();
    fireEvent.click(closer());
    expect(opener().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape returns from a detail to the overview, and a second Escape closes it", async () => {
    mount();
    await openMetric(/^Protein/);
    fireEvent.keyDown(back(), { key: "Escape" });
    await expectOverview();
    fireEvent.keyDown(closer(), { key: "Escape" });
    expect(opener().getAttribute("aria-expanded")).toBe("false");
  });

  it("states an overage honestly, in words as well as colour", async () => {
    mount({ consumed: { ...consumed, kcal: 2250 } });
    const panel = await openMetric(/^Calories eaten/);
    expect(panel.textContent).toContain("250 kcal over");
    expect(panel.textContent).not.toContain("left");
  });
});

describe("HealthOrbit · docked", () => {
  it("tells the docked orb when a metric's detail replaces the ring, and when it returns", async () => {
    const onDetailChange = vi.fn();
    mount({ docked: { id: "orbit", open: true, onOpenChange: () => {}, onDetailChange } });
    expect(onDetailChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(metric(/^Fat/));
    await waitFor(() => expect(onDetailChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(back());
    await waitFor(() => expect(onDetailChange).toHaveBeenLastCalledWith(false));
  });
});

describe("HealthOrbit · reduced motion", () => {
  it("opens and closes without a tween and leaves the constellation still", async () => {
    mount({}, true);
    fireEvent.click(opener());
    expect(within(ring()!).getAllByRole("button")).toHaveLength(7);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ring()!.style.transform).not.toMatch(/rotate\((?!0deg)/);
    fireEvent.click(closer());
    await waitFor(() => expect(ring()).toBeNull(), { timeout: 100 });
  });
});

describe("HealthOrbit · water", () => {
  it("keeps tap-to-add, the bounded steps and the hold-drag in the water detail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onAddCup, onSetCups, rerender } = mount({ water: { cups: MAX_CUPS - 1, goal: 8 } });
    await openMetric(/^Water/);
    const dial = screen.getByRole("button", { name: /^Water: .*Tap adds a cup/ });
    fireEvent.pointerDown(dial, { pointerType: "mouse", button: 0, clientX: 40 });
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: 40 });
    expect(onAddCup).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(dial, { pointerType: "mouse", button: 0, clientX: 40 });
    act(() => { vi.advanceTimersByTime(450); });
    fireEvent.pointerMove(dial, { pointerType: "mouse", clientX: 40 + PX_PER_CUP * 5 });
    fireEvent.pointerUp(dial, { pointerType: "mouse", clientX: 40 + PX_PER_CUP * 5 });
    expect(onSetCups).toHaveBeenLastCalledWith(MAX_CUPS);

    fireEvent.click(screen.getByRole("button", { name: "One more cup of water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(MAX_CUPS);
    rerender(<HealthOrbit targets={targets} consumed={consumed} water={{ cups: MAX_CUPS, goal: 8 }}
      onAddCup={onAddCup} onSetCups={onSetCups} body={ready} />);
    expect((screen.getByRole("button", { name: "One more cup of water" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "One less cup of water" }));
    expect(onSetCups).toHaveBeenLastCalledWith(MAX_CUPS - 1);
  });

  it("says Loading while the day's water is unread, with no controls and no zero", async () => {
    mount({ water: undefined });
    const panel = await openMetric(/^Water/);
    expect(panel.textContent).toContain("Loading…");
    expect(screen.queryByRole("button", { name: "One more cup of water" })).toBeNull();
    expect(panel.textContent).not.toContain("0 cups");
  });
});

describe("HealthOrbit · activity and recovery", () => {
  it("shows active energy and steps, labelled as a device estimate, with a route to Body", async () => {
    mount();
    const panel = await openMetric(/^Active burn/);
    expect(panel.textContent).toContain("412 kcal");
    expect(panel.textContent).toContain("8,012");
    expect(panel.textContent).toContain("not added to your food target");
    expect(within(panel).getByRole("link", { name: /body/i }).getAttribute("href")).toBe("/body");
  });

  it("shows sleep and readiness when present", async () => {
    mount();
    const panel = await openMetric(/^Sleep and recovery/);
    expect(panel.textContent).toContain("7h 24m");
    expect(panel.textContent).toContain("82");
  });

  it("never turns missing, loading or offline data into zero", async () => {
    const { unmount } = mount({ body: { ...ready, loading: true, row: null } });
    let panel = await openMetric(/^Active burn/);
    expect(panel.textContent).toContain("Loading…");
    expect(panel.textContent).not.toMatch(/\b0 kcal/);
    unmount();

    const second = mount({ body: { ...ready, row: { ...ROW, active_kcal: null, steps: null } } });
    panel = await openMetric(/^Active burn/);
    expect(panel.textContent).toContain("No activity recorded for this day");
    second.unmount();

    const third = mount({ body: { ...ready, offline: true, fetchedAt: null } });
    panel = await openMetric(/^Sleep and recovery/);
    expect(panel.textContent).toContain("Offline");
    third.unmount();

    mount({ body: { ...ready, capability: "disabled", row: null } });
    panel = await openMetric(/^Active burn/);
    expect(panel.textContent).toContain("Body data is off");
    expect(within(panel).getByRole("link", { name: /settings/i }).getAttribute("href")).toBe("/settings");
  });
});
