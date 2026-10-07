/**
 * T0 §2 — "after 2 s on any step the sheet shows what it is doing".
 *
 * Vitest runs in the Node environment and React Testing Library is not installed, so the timer
 * itself is a manual phone gate; what is asserted here is the contract around it — the delay, the
 * copy per step, the live-region markup, and the one rule that matters before the delay elapses:
 * the line renders nothing at all, so a fast answer never flashes a "still working" note.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WorkingLine, {
  WORKING_COPY, WORKING_DELAY_MS, WorkingLineView, isThinkingStep, workingCopy, workingLineController,
} from "@/components/WorkingLine";

describe("the delay", () => {
  it("is the spec's two seconds", () => {
    expect(WORKING_DELAY_MS).toBe(2000);
  });

  it("renders nothing while it has not elapsed", () => {
    expect(renderToStaticMarkup(<WorkingLine active step="propose" />)).toBe("");
  });

  it("renders nothing at all when no step is running", () => {
    expect(renderToStaticMarkup(<WorkingLine active={false} step="propose" />)).toBe("");
  });
});

describe("which hop the delay belongs to", () => {
  /**
   * The hop is the step, not the words on it. A capture whose method is known late — a voice clip
   * that turns out to be a label — is still the SAME upload she has been waiting on, so the line
   * must stay on screen and simply say something truer. Putting `method` in the effect's deps made
   * that change hide the line and start the two seconds again (panel round 10, item 1).
   *
   * There is no renderer here to run the effect, so this reads the deps the effect declares; the
   * words themselves are read at render, which the copy tests below cover.
   */
  it("re-times on the step alone, so a change of method never restarts the wait", () => {
    const source = readFileSync(new URL("./WorkingLine.tsx", import.meta.url), "utf8");
    const deps = source.match(/\}, \[([^\]]*)\]\);/)?.[1] ?? "";
    expect(deps.split(",").map((d) => d.trim())).toEqual(["active", "step", "delayMs"]);
  });

  it("says something different for the same step under a different method", () => {
    // What the line SAYS comes from the props at render, so the words change without the
    // controller — and so without the line going away and coming back.
    expect(workingCopy("upload", "voice")).not.toBe(workingCopy("upload", "label"));
    expect(renderToStaticMarkup(<WorkingLineView text={workingCopy("upload", "voice")} />))
      .toContain("Listening…");
  });
});

describe("the copy", () => {
  it("says what it is doing, in the spec's words, for the hops she waits on", () => {
    expect(workingCopy("upload")).toBe("Sending it…");
    expect(workingCopy("propose")).toBe("Finding matches…");
    expect(workingCopy("commit")).toBe("Saving…");
  });

  it("names what it is actually reading, per capture method", () => {
    // Grok pass 2, MEDIUM 11: "Reading the label…" was hard-coded for the upload hop, so a plate
    // photo and a voice clip both claimed to be reading a label.
    expect(workingCopy("upload", "label")).toBe("Reading the label…");
    expect(workingCopy("upload", "photo")).toBe("Looking at the plate…");
    expect(workingCopy("upload", "voice")).toBe("Listening…");
  });

  it("keeps the shared line for a hop the method does not change", () => {
    expect(workingCopy("commit", "photo")).toBe("Saving…");
    expect(workingCopy("propose", "voice")).toBe("Finding matches…");
  });

  it("covers every step she can be waiting on, and never apologises or shouts", () => {
    for (const line of Object.values(WORKING_COPY)) {
      expect(line.endsWith("…")).toBe(true);
      expect(line.toLowerCase()).not.toContain("sorry");
      expect(line).not.toContain("!");
    }
  });

  it("falls back to a plain line rather than an empty one", () => {
    expect(workingCopy("card-visible")).toBe(WORKING_COPY["card-visible"]);
  });
});

describe("the line itself", () => {
  const html = renderToStaticMarkup(<WorkingLineView text="Saving…" />);

  it("is announced, because she cannot see a change she is not told about", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("shows the words", () => {
    expect(html).toContain("Saving…");
  });
});

/**
 * Grok 4.6 HIGH 4: the second hop of a run showed its line instantly, because the "two seconds
 * have passed" state survived the hop ending. `renderToStaticMarkup` never runs effects, so the
 * delay itself is tested on the controller the component's effect drives — which is where the
 * state lives, and the reason it can no longer survive a deactivation.
 */
describe("workingLineController", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stays hidden for the whole delay, then shows", () => {
    const seen: boolean[] = [];
    const line = workingLineController((shown) => seen.push(shown));
    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true]);
  });

  it("hides again when the hop ends, and the next hop waits its own two seconds", () => {
    const seen: boolean[] = [];
    const line = workingLineController((shown) => seen.push(shown));

    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS);
    expect(seen).toEqual([true]);

    line.stop();
    expect(seen).toEqual([true, false]);

    // The same step, running again: it must not inherit the fact that it once took two seconds.
    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS - 1);
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false, true]);
  });

  it("drops a pending timer when the hop ends before the delay is up", () => {
    const seen: boolean[] = [];
    const line = workingLineController((shown) => seen.push(shown));
    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS - 1);
    line.stop();
    vi.advanceTimersByTime(WORKING_DELAY_MS);
    expect(seen).toEqual([]);
  });

  it("re-times rather than stacking when a new hop starts while one is pending", () => {
    const seen: boolean[] = [];
    const line = workingLineController((shown) => seen.push(shown));
    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS - 500);
    line.start();
    vi.advanceTimersByTime(WORKING_DELAY_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true]);
  });
});

describe("which waits show the thinking orbs", () => {
  it("gives a model hop the shared Thinking line and keeps a save as plain words", () => {
    expect(isThinkingStep("propose")).toBe(true);
    expect(isThinkingStep("upload")).toBe(true);
    expect(isThinkingStep("commit")).toBe(false);
    const thinking = renderToStaticMarkup(<WorkingLineView text="Finding matches…" thinking />);
    expect(thinking).toContain('data-thinking="inline"');
    expect(thinking).toContain('role="status"');
    expect(renderToStaticMarkup(<WorkingLineView text="Saving…" />)).not.toContain("data-thinking");
  });
});
