/**
 * Split audit, finding 1: DESIGN.md keeps the four gauge colours fixed per macro. The four T11a
 * cards own them; the three T11b cards (resting heart rate, HRV, readiness) are not macros and must
 * stroke in the neutral secondary text token instead of borrowing one.
 *
 * Rendered statically, because the stroke is an attribute of the drawn path and that is the thing
 * the audit is about — the series' own colour string, not a class name that could be remapped.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import BodyDashboard from "@/components/BodyDashboard";
import type { DailyHealthRow } from "@/lib/health/contract";

const GAUGE_COLOURS = ["var(--color-gauge-calories)", "var(--color-gauge-protein)",
  "var(--color-gauge-carbs)", "var(--color-gauge-fat)"];
const NEUTRAL = "var(--color-text-secondary)";
const NEW_CARDS = ["Resting heart rate", "HRV", "Readiness"];
const T11A_CARDS = [["Weight", "var(--color-gauge-protein)"], ["Sleep", "var(--color-gauge-carbs)"],
  ["Steps", "var(--color-gauge-fat)"],
  ["Device active energy estimate", "var(--color-gauge-calories)"]] as const;

const row = (local_date: string, over: Partial<DailyHealthRow> = {}): DailyHealthRow => ({
  local_date, steps: null, active_kcal: null, sleep_minutes: null, body_mass_kg: null,
  resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, sources: [], provenance: {},
  ...over });

/** Seven days with every series populated, so each card draws a path and a stroke to read. */
const WEEK: DailyHealthRow[] = ["12", "13", "14", "15", "16", "17", "18"]
  .map((day, i) => row(`2026-09-${day}`, { body_mass_kg: 57.6 + i / 10, sleep_minutes: 420 + i,
    steps: 1200 + i, active_kcal: 350 + i, resting_heart_rate: 45 + i, hrv_sdnn: 40 + i,
    readiness_score: 70 + i }));

const MARKUP = renderToStaticMarkup(<BodyDashboard response={{ days: WEEK, sources: [] }}
  chart={WEEK} fetchedAt={null} offline={false} onOpenSources={() => {}} />);

/** The stroke on the card named `eyebrow`, found by its sparkline's accessible name. */
function strokeOf(eyebrow: string): string | null {
  const at = MARKUP.indexOf(`aria-label="${eyebrow}, last seven days"`);
  expect(at).toBeGreaterThan(-1);
  return /stroke="([^"]+)"/.exec(MARKUP.slice(at, at + 600))?.[1] ?? null;
}

const allStrokes = [...MARKUP.matchAll(/stroke="([^"]+)"/g)].map((match) => match[1]);

describe("the metric cards' strokes", () => {
  it("strokes the three new heart and readiness cards in the neutral token", () => {
    for (const eyebrow of NEW_CARDS) expect(strokeOf(eyebrow)).toBe(NEUTRAL);
    expect(allStrokes.filter((stroke) => stroke === NEUTRAL)).toHaveLength(NEW_CARDS.length);
  });

  it("never lets the three new cards borrow one of the four macro gauge colours", () => {
    for (const eyebrow of NEW_CARDS) expect(GAUGE_COLOURS).not.toContain(strokeOf(eyebrow));
    // The gauge tokens appear once each, on the four T11a cards — no card draws a second one.
    expect(allStrokes.filter((stroke) => GAUGE_COLOURS.includes(stroke)))
      .toHaveLength(T11A_CARDS.length);
  });

  // These four landed on main this way (T11a) and are not this round's to change.
  it("leaves the four T11a cards on their fixed macro colours", () => {
    for (const [eyebrow, colour] of T11A_CARDS) expect(strokeOf(eyebrow)).toBe(colour);
  });
});
