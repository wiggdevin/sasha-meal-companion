// @vitest-environment jsdom
/**
 * Sprout's awards and the well's messages (owner, 2026-10-07). The catalog is safe for a health app;
 * a player under reduced motion shows the finished award at once with its words and no sound; Escape
 * and Done close it; messages come one at a time, the most urgent first.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import AwardPlayer from "./AwardPlayer";
import CareNotes, { nextNote, type CareNote } from "./CareNotes";
import { AWARDS, MATERIAL_ART, awardByKey } from "./awards";

afterEach(cleanup);

describe("the award catalog", () => {
  it("has unique keys, art for every material, and lines that observe rather than instruct", () => {
    expect(new Set(AWARDS.map((a) => a.key)).size).toBe(AWARDS.length);
    const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../../public");
    for (const src of Object.values(MATERIAL_ART)) expect(existsSync(join(publicDir, src)), src).toBe(true);
    for (const award of AWARDS) {
      expect(award.line).not.toMatch(/\b(eat|should|must|try to|don't|need to)\b/i);
      expect(award.title).not.toMatch(/\b(lose|lost|calorie|deficit|skip)\b/i);
    }
  });

  it("never rewards eating less, going under, short sleep or fast loss; weight only on opt-in with a loss goal", () => {
    for (const award of AWARDS) expect(award.trigger).not.toMatch(/under (target|calories)|deficit|less sleep|fast/i);
    expect(awardByKey("weight-milestone")?.trigger).toMatch(/opt-in AND a loss goal/);
  });
});

describe("AwardPlayer", () => {
  it("shows the finished award at once under reduced motion, and Done closes it", () => {
    const onClose = vi.fn();
    render(<MotionConfig reducedMotion="always"><AwardPlayer award={awardByKey("workout-pair")!} onClose={onClose} /></MotionConfig>);
    expect(screen.getByRole("dialog", { name: "Award: Two in a row" })).toBeTruthy();
    expect(screen.getByText("Two workout days in a row.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<MotionConfig reducedMotion="always"><AwardPlayer award={awardByKey("seven-days")!} onClose={onClose} /></MotionConfig>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("CareNotes", () => {
  const tip: CareNote = { id: "t", type: "tip", title: "A tip", text: "Tap the rainbow." };
  const sys: CareNote = { id: "s", type: "system", text: "Saved here. Sync is pending." };
  const acc: CareNote = { id: "a", type: "accolade", award: awardByKey("goal-5")! };

  it("shows the most urgent message first: a sync problem, then an award, then a tip", () => {
    expect(nextNote([tip, acc, sys])?.id).toBe("s");
    expect(nextNote([tip, acc])?.id).toBe("a");
    expect(nextNote([])).toBeNull();
    // Equal urgency, no timestamps: the later one is the newer.
    const tip2: CareNote = { id: "t2", type: "tip", title: "Another", text: "x" };
    expect(nextNote([tip, tip2])?.id).toBe("t2");
  });

  it("offers Watch on an award and announces politely", () => {
    const onWatch = vi.fn();
    render(<MotionConfig reducedMotion="always"><CareNotes note={acc} onWatch={onWatch} onDismiss={() => {}} /></MotionConfig>);
    const note = screen.getByRole("status");
    expect(note.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(onWatch).toHaveBeenCalledWith(acc.award);
  });

  it("names the chosen companion, as the award player does (UI audit 2026-10-07)", () => {
    const week: CareNote = { id: "w", type: "accolade", award: awardByKey("seven-days")! };
    render(<MotionConfig reducedMotion="always"><CareNotes note={week} mascot="peapod" onWatch={() => {}} onDismiss={() => {}} /></MotionConfig>);
    // Both what is said and the card people see.
    for (const note of [screen.getByRole("status"), document.querySelector<HTMLElement>("[data-type='accolade']")!]) {
      expect(note.textContent).toContain("A week of days recorded with Pod.");
      expect(note.textContent).not.toContain("Sprout");
    }
  });

  it("keeps one live region mounted, so a note that arrives later is announced (UI audit 2026-10-18)", () => {
    const { rerender } = render(<MotionConfig reducedMotion="always"><CareNotes note={null} onWatch={() => {}} onDismiss={() => {}} /></MotionConfig>);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    rerender(<MotionConfig reducedMotion="always"><CareNotes note={tip} onWatch={() => {}} onDismiss={() => {}} /></MotionConfig>);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toContain(tip.text);
    // The card with its buttons is not itself the live region.
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("drops notes into the bottom of the water view, clear of Add a cup", () => {
    const { container } = render(<MotionConfig reducedMotion="always"><CareNotes note={tip} place="bottom" onWatch={() => {}} onDismiss={() => {}} /></MotionConfig>);
    expect(container.querySelector("[data-place='bottom']")).toBeTruthy();
  });
});
