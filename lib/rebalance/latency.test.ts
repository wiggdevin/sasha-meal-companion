/**
 * Phase 19 §8 / §9 R1: p95 of the panel's own work (projectPanelSlots + dayBalance + classifyDay)
 * over 10,000 generated days stays within 5 ms. The days are resolved first, outside the timing:
 * the panel reuses Today's resolveDay result and adds no resolve of its own.
 */
import { describe, expect, it } from "vitest";
import { projectPanelSlots } from "@/lib/plan/panel-slots";
import { resolveDay } from "@/lib/resolve";
import type { ResolvedDay, SlotId, StoredDay } from "@/lib/types";
import { account, DATE, entry, item, saved } from "./__fixtures__/days";
import { dayBalance } from "./balance";
import { classifyDay } from "./classify";

const DAYS = 10_000;
const MEALS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5"];

/** Deterministic xorshift, so every run times the same days. */
function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function generatedDay(next: () => number): StoredDay {
  const stored: StoredDay = { date: DATE, eaten: {}, itemOverrides: {}, extras: [] };
  for (const slot of MEALS) {
    const roll = next();
    if (roll < 0.25) stored.eaten![slot] = `${DATE}T09:00:00Z`;
    if (roll < 0.15 || (roll > 0.4 && roll < 0.7)) stored.itemOverrides![slot] = saved(200 + Math.floor(next() * 600));
    else if (roll > 0.9) stored.itemOverrides![slot] = { baseMealId: null, components: [], cleared: true };
    if (next() < 0.3) {
      stored.extras!.push(entry(`${slot}-log`, [item(next() < 0.8 ? { reported: Math.floor(next() * 400) } : {})],
        next() < 0.5 ? slot : "snack"));
    }
  }
  return stored;
}

describe("latency budget", () => {
  it(`keeps p95 within 5 ms over ${DAYS.toLocaleString("en-US")} generated days`, () => {
    const next = random(19);
    const days: { day: ResolvedDay; stored: StoredDay }[] = [];
    for (let i = 0; i < DAYS; i += 1) {
      const store = account(1400 + Math.floor(next() * 1800), 3 + Math.floor(next() * 3));
      const stored = generatedDay(next);
      store.days[DATE] = stored;
      days.push({ day: resolveDay(store, DATE), stored });
    }
    const timings: number[] = [];
    let states = 0;
    for (const { day, stored } of days) {
      const minutes = Math.floor(next() * 24 * 60);
      const start = performance.now();
      const slots = projectPanelSlots(day, stored);
      const panel = classifyDay(DATE, DATE, dayBalance(day, slots, { date: DATE, minutes }));
      timings.push(performance.now() - start);
      if (panel.state !== "hidden") states += 1;
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(DAYS * 0.95)];
    console.info(`rebalance p95 ${p95.toFixed(4)} ms, p50 ${timings[DAYS / 2].toFixed(4)} ms, `
      + `max ${timings[DAYS - 1].toFixed(4)} ms over ${DAYS} days`);
    expect(states).toBe(DAYS);
    expect(p95).toBeLessThanOrEqual(5);
  });
});
