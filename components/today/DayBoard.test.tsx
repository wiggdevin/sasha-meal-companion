// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayBoard from "./DayBoard";
import { DAY_CARD_EXPLAINER } from "./ExplainerPlayer";
import { APP_TIPS, boardTips, type WeekDay, type WeekSummary } from "@/lib/today/board";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import { BOARD_MORPH, boardMorph } from "./useDayCardMotion";
import type { OrbitWater } from "@/lib/today/health-orbit";

/**
 * The board's tip opens in place (2026-10-03): the tile grows into the tip's full view inside the
 * board, never a dialog or a portal; X and Escape close it and focus returns to the tile; the
 * tiles under it stay mounted and inert. Water and the tip share one row and one height.
 */
const TODAY = "2026-10-06";
const MEAL = "Eggs & Jasmine rice";

beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function mount({ water = { cups: 4, goal: 8 } as OrbitWater, reduced = false, date = TODAY } = {}) {
  const board = <DayBoard date={date} today={TODAY} water={water} onAddCup={() => {}} active
    next={{ slot: "meal-2", label: "Meal 2", name: MEAL, time: "10:30", kcal: 940, protein: 42, image: null }}
    planned={3} onMarkEaten={() => {}} tips={boardTips()} explainers={[DAY_CARD_EXPLAINER]} />;
  return render(reduced ? <MotionConfig reducedMotion="always">{board}</MotionConfig> : board);
}

const live = (scope: HTMLElement) => scope.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')!;
const openButton = () => screen.getByRole("button", { name: /^Open tip: / });
/** The open view, while it is still there for assistive tech; shrinking back, it is aria-hidden. */
const view = () => document.querySelector("[data-tip-view]:not([aria-hidden])");
/** The view in the DOM at all, shrinking or not. */
const anyView = () => document.querySelector("[data-tip-view]");

describe("DayBoard · the tip opens in place", () => {
  it("grows the tile into the full view inside the board, with no dialog and no portal", async () => {
    const { container } = mount();
    const bodyChildren = document.body.children.length;
    const first = APP_TIPS.find((tip) => live(container).textContent?.includes(tip.title))!;
    fireEvent.click(openButton());
    const region = await screen.findByRole("region", { name: first.title });
    expect(container.contains(region)).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.children.length).toBe(bodyChildren);
    // The full details: the summary, every step and the demonstration.
    expect(region.textContent).toContain(first.text);
    for (const step of first.steps) expect(region.textContent).toContain(step);
    expect(region.querySelector(`svg[data-demo="${first.demo}"]`)).not.toBeNull();
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Close tip" }));
  });

  it("keeps every other tile mounted and inert under the open tip", async () => {
    mount();
    const eat = screen.getByRole("button", { name: `Mark ${MEAL} eaten` });
    const water = screen.getByRole("button", { name: /^Add .* of water/ });
    fireEvent.click(openButton());
    await screen.findByRole("region", { name: /./ });
    for (const tile of [eat, water]) {
      expect(tile.isConnected).toBe(true);
      expect(tile.closest("[inert]")).not.toBeNull();
      expect(tile.closest("[aria-hidden=\"true\"]")).not.toBeNull();
    }
    expect(screen.queryByRole("button", { name: `Mark ${MEAL} eaten` })).toBeNull();
  });

  it("closes with the X and hands focus back to the tile", async () => {
    mount();
    const tile = openButton();
    fireEvent.click(tile);
    const region = await screen.findByRole("region", { name: /./ });
    fireEvent.click(within(region).getByRole("button", { name: "Close tip" }));
    await waitFor(() => expect(view()).toBeNull(), { timeout: 3000 });
    // Focus goes back once the view has landed in the tile and handed over to it.
    await waitFor(() => expect(document.activeElement).toBe(tile), { timeout: 3000 });
    expect(screen.getByRole("button", { name: `Mark ${MEAL} eaten` })).toBeTruthy();
  });

  it("closes on Escape and hands focus back to the tile", async () => {
    mount();
    const tile = openButton();
    fireEvent.click(tile);
    const region = await screen.findByRole("region", { name: /./ });
    fireEvent.keyDown(within(region).getByRole("button", { name: "Close tip" }), { key: "Escape" });
    await waitFor(() => expect(view()).toBeNull(), { timeout: 3000 });
    // Focus goes back once the view has landed in the tile and handed over to it.
    await waitFor(() => expect(document.activeElement).toBe(tile), { timeout: 3000 });
  });

  it("opens and closes without a morph or a moving demonstration under reduced motion", async () => {
    mount({ reduced: true });
    const tile = openButton();
    fireEvent.click(tile);
    const region = await screen.findByRole("region", { name: /./ });
    expect(region.querySelector("svg[data-demo]")?.getAttribute("data-still")).toBe("true");
    fireEvent.click(within(region).getByRole("button", { name: "Close tip" }));
    // No shrink back into the tile to wait for: the view is gone within a frame or two.
    await waitFor(() => expect(anyView()).toBeNull(), { timeout: 200 });
    await waitFor(() => expect(document.activeElement).toBe(tile));
  });

  it("pages through the tips inside the open view, and closes into the tip it was last on (OD17)", async () => {
    const { container } = mount({ reduced: true });
    const first = APP_TIPS.find((tip) => live(container).textContent?.includes(tip.title))!;
    fireEvent.click(openButton());
    const region = await screen.findByRole("region", { name: first.title });
    const paging = within(region).getByRole("navigation", { name: "Tips" });
    expect(paging.textContent).toContain(`1 of ${APP_TIPS.length}`);
    fireEvent.click(within(region).getByRole("button", { name: "Next tip" }));
    const second = await screen.findByRole("region", { name: /./ });
    expect(second.textContent).toContain(`2 of ${APP_TIPS.length}`);
    expect(second.querySelector('[aria-live="polite"]')?.textContent).toMatch(new RegExp(`^Tip 2 of ${APP_TIPS.length}\\.`));
    const shownTitle = second.querySelector("h3")!.textContent!;
    expect(shownTitle).not.toBe(first.title);
    fireEvent.click(within(second).getByRole("button", { name: "Previous tip" }));
    await waitFor(() => expect(screen.getByRole("region", { name: first.title })).toBeTruthy());
    fireEvent.click(within(screen.getByRole("region", { name: first.title })).getByRole("button", { name: "Previous tip" }));
    // Wraps from the first back to the last.
    await waitFor(() => expect(view()?.textContent).toContain(`${APP_TIPS.length} of ${APP_TIPS.length}`));
    const lastTitle = view()!.querySelector("h3")!.textContent!;
    fireEvent.click(within(view() as HTMLElement).getByRole("button", { name: "Close tip" }));
    await waitFor(() => expect(anyView()).toBeNull(), { timeout: 200 });
    expect(screen.getByRole("button", { name: /^Open tip: / }).getAttribute("aria-label")).toBe(`Open tip: ${lastTitle}`);
  });

  it("leads with the tip that matters now: no water yet today puts the water tip first", () => {
    const { container } = mount({ water: { cups: 0, goal: 8 } });
    const water = APP_TIPS.find((tip) => tip.id === "water")!;
    expect(live(container).textContent).toBe(`Tip 1 of ${APP_TIPS.length}. ${water.title}. ${water.text}`);
  });
});

describe("DayBoard · water and the tip share one row", () => {
  it("puts both tiles in sibling cells of the same grid row, each handing its tile all of the row", () => {
    mount();
    const water = screen.getByRole("button", { name: /^Add .* of water/ }).closest<HTMLElement>("[data-pair]")!;
    const tip = openButton().closest<HTMLElement>("[data-pair]")!;
    expect(water.getAttribute("data-pair")).toBe("water");
    expect(tip.getAttribute("data-pair")).toBe("tip");
    expect(water.className).toBe(tip.className);
    expect(water.parentElement).toBe(tip.parentElement);
    expect(water.nextElementSibling).toBe(tip);
  });

  it("sets the shared height in the row's cells, and neither tile holds a height of its own", () => {
    const css = (file: string) => readFileSync(join(process.cwd(), "components/today", file), "utf8");
    const rule = (source: string, selector: string) =>
      new RegExp(`${selector.replace(/[.>*]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? "";
    const board = css("DayBoard.module.css");
    expect(rule(board, ".grid")).toMatch(/display:\s*grid/);
    expect(rule(board, ".pairCell")).toMatch(/display:\s*flex/);
    expect(rule(board, ".pairCell")).toMatch(/flex-direction:\s*column/);
    expect(rule(board, ".pairCell")).toMatch(/min-height:\s*\d+px/);
    expect(rule(board, ".pairCell > *")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(css("WaterTile.module.css"), ".tile")).not.toMatch(/(^|[^-])(min-)?height:/);
    expect(rule(css("TipTile.module.css"), ".tip")).not.toMatch(/(^|[^-])(min-)?height:/);
    // The water fills the tile's whole height.
    expect(rule(css("WaterTile.module.css"), ".liquid")).toMatch(/inset:\s*0/);
  });
});


const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real boxes for the small and large ends of each morph, so Motion runs the shared-element
 *  transform between them as it does on the phone (jsdom lays nothing out). A closing frame sits in
 *  its tile's box. */
function stubBoxes() {
  const own = Element.prototype.getBoundingClientRect;
  const rect = (x: number, y: number, w: number, h: number) =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  const tile = rect(200, 120, 160, 140);
  const pin = rect(16, 400, 360, 86);
  const big = rect(16, 4, 360, 480);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute("data-tip-tile")) return tile;
    if (this.hasAttribute("data-explainer-pin")) return pin;
    if (this.hasAttribute("data-tip-view")) return this.hasAttribute("data-closing") ? tile : big;
    if (this.hasAttribute("data-explainer-player")) return this.hasAttribute("data-closing") ? pin : big;
    return own.call(this);
  };
  onTestFinished(() => { Element.prototype.getBoundingClientRect = own; });
}
const opacityOf = (el: Element | null) => {
  const value = (el as HTMLElement | null)?.style.opacity ?? "";
  return value === "" ? 1 : Number(value);
};

/**
 * The tip view and the explainer player ride one timeline (useDayCardMotion.ts `BOARD_MORPH`,
 * owner 2026-10-03): closing is the open run backwards on the same spring and soft-lands; the frame
 * is never faded, only its content; the tiles stay under it and fade rather than vanish.
 */
describe("DayBoard · open and close share one timeline", () => {
  it("grows and shrinks the frame on the same gentle spring, which lands softly without a wobble", () => {
    expect(BOARD_MORPH.frame).toBe(SPRINGS.gentle);
    expect(BOARD_MORPH.frame.bounce).toBeGreaterThan(0);
    expect(BOARD_MORPH.frame.bounce).toBeLessThanOrEqual(0.15);
    // The tiles leave over the frame's own visual duration, without its overshoot.
    expect(BOARD_MORPH.tilesOut.visualDuration).toBe(BOARD_MORPH.frame.visualDuration);
    expect(BOARD_MORPH.tilesOut.bounce).toBe(0);
  });

  it("fades the content only while the frame is big, and brings the small face back as it lands", () => {
    const m = BOARD_MORPH;
    const land = m.frame.visualDuration;
    const end = (fade: { duration: number; delay?: number }) => (fade.delay ?? 0) + fade.duration;
    // Opening: the tile's face is gone before the view's content starts to arrive.
    expect(end(m.faceOut)).toBeLessThanOrEqual(m.contentIn.delay);
    expect(m.contentIn.delay).toBeGreaterThan(0);
    // Closing: the content leaves first, then the face and the pin's ivory come back by the landing.
    expect(m.contentOut).not.toHaveProperty("delay");
    expect(end(m.contentOut)).toBeLessThanOrEqual(m.faceIn.delay);
    expect(end(m.faceIn)).toBeCloseTo(land);
    expect(end(m.surfaceIn)).toBeCloseTo(land);
    expect(m.surfaceIn.duration).toBe(m.surfaceOut.duration);
    // The tiles come back over the last part of the shrink and are in place as the frame lands.
    expect(m.tilesIn.delay + m.tilesIn.visualDuration).toBeCloseTo(land);
  });

  it("makes every step instant under reduced motion", () => {
    for (const step of Object.values(boardMorph(true))) expect(step).toBe(INSTANT);
    expect(boardMorph(false)).toBe(BOARD_MORPH);
  });

  it("opens the tip with the view opaque from the first frame and the tiles fading under it", async () => {
    stubBoxes();
    mount();
    const tiles = document.querySelector("[data-tip-tiles]")!;
    fireEvent.click(openButton());
    const region = await screen.findByRole("region", { name: /./ });
    // Still there, still visible at first: covered, not removed.
    expect(tiles.isConnected).toBe(true);
    expect(tiles.hasAttribute("data-covered")).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { seen.push(opacityOf(region)); await wait(16); }
    expect(Math.min(...seen)).toBe(1);
    expect(opacityOf(tiles)).toBeGreaterThan(0);
    await waitFor(() => expect(opacityOf(tiles)).toBeLessThan(0.05), { timeout: 2000 });
  });

  it("closes the tip by shrinking the opaque frame into the tile, content first, tiles back underneath", async () => {
    stubBoxes();
    mount();
    const tiles = document.querySelector("[data-tip-tiles]")!;
    fireEvent.click(openButton());
    const region = await screen.findByRole("region", { name: /./ });
    fireEvent.click(within(region).getByRole("button", { name: "Close tip" }));
    const frame = document.querySelector<HTMLElement>("[data-tip-view]")!;
    expect(frame.hasAttribute("data-closing")).toBe(true);
    expect(frame.style.position).toBe("absolute");
    // The tiles are back in the flow and reachable at once, fading in while the frame shrinks.
    expect(tiles.hasAttribute("data-covered")).toBe(false);
    expect(tiles.hasAttribute("inert")).toBe(false);
    const content = frame.firstElementChild!;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) { seen.push(opacityOf(frame)); await wait(16); }
    expect(Math.min(...seen)).toBe(1);
    expect(opacityOf(content)).toBeLessThan(0.05);
  });

  it("closes the explainer the same way: the dark frame stays opaque while its content leaves", async () => {
    stubBoxes();
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Play How your Day card works/ }));
    const player = await screen.findByRole("region", { name: "How your Day card works" });
    const seenOpen: number[] = [];
    for (let i = 0; i < 6; i++) { seenOpen.push(opacityOf(player)); await wait(16); }
    expect(Math.min(...seenOpen)).toBe(1);
    fireEvent.click(within(player).getByRole("button", { name: "Close How your Day card works" }));
    expect(player.hasAttribute("data-closing")).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) { seen.push(opacityOf(player)); await wait(16); }
    expect(Math.min(...seen)).toBe(1);
    const content = player.querySelector("h3")!.parentElement!;
    expect(opacityOf(content)).toBeLessThan(0.05);
    // As it lands it wears the pin's ivory again.
    await waitFor(() => expect(opacityOf(player.querySelector("[data-explainer-veil]"))).toBeGreaterThan(0.95), { timeout: 2000 });
  });
});

/* t23 #9: WeekSummary.averagePartial marks the week strip's "Average … on logged days" line as a
   lower bound, through the same lib/nutrition-display.ts wording every other surface uses. */
describe("DayBoard · the week average", () => {
  function week(averagePartial: boolean): WeekSummary {
    const days: WeekDay[] = Array.from({ length: 7 }, (_, i): WeekDay => ({
      date: `2026-09-2${i + 1}`, letter: "MTWTFSS"[i], kcal: 1800, target: 2000,
      status: "all done", isToday: false, isViewed: false,
    }));
    return { days, onPlan: 5, elapsed: 7, averageKcal: 1800, averagePartial };
  }

  it("says at least on a week average fed by a partly measured day, and plainly otherwise", () => {
    const { container, rerender } = render(<DayBoard date={TODAY} today={TODAY} active next={null}
      planned={0} tips={[]} explainers={[]} week={week(true)} />);
    expect(container.textContent).toContain("at least");
    rerender(<DayBoard date={TODAY} today={TODAY} active next={null} planned={0} tips={[]} explainers={[]}
      week={week(false)} />);
    expect(container.textContent).not.toContain("at least");
    expect(container.textContent).toContain("Average");
  });
});
