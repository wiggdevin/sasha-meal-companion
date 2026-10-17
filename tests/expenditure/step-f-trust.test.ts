/**
 * TDEE step F (docs/plans/2026-09-22-tdee-engine-plan.md §F), noise-and-trust cases no other test
 * held: the fluid cycle at EVERY starting phase (handoff.test.ts replays every 4th), missing days
 * against the held rule (R8), runtime time zones and DST, and a pinned replay of the six
 * fixture scenarios tied to ENGINE_VERSION, so a numbers change without a version bump fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENGINE_VERSION, estimateExpenditure, fromDayNumber, HELD_LOOKBACK_DAYS, toDayNumber,
} from "@/lib/expenditure";
import {
  buildScenario, replayScenario, SCENARIOS, START_DATE, toScenarioDay, type Scenario,
} from "@/lib/expenditure.fixtures";

function night(scenario: Scenario, day: number, seedKcal = 2130, bmrKcal = 1372) {
  const end = toDayNumber(START_DATE) + day;
  return estimateExpenditure({ asOf: fromDayNumber(end), seedKcal, bmrKcal,
    weighIns: scenario.weighIns.filter((w) => toDayNumber(w.date) < end),
    intake: scenario.intake.filter((i) => toDayNumber(i.date) < end) });
}

describe("step F trust — ±1.2 kg 28-day fluid cycle at every one of the 28 starting phases", () => {
  it("from day 42 every sampled night is within 4 % of truth and the cycle is named by day 84",
    () => {
      const TRUTH = 2130;
      let eligible = 0;
      for (let phase = 0; phase < 28; phase += 1) {
        const scenario = buildScenario({ label: `phase-${phase}`, seed: 9200 + phase,
          tdee: () => TRUTH, intake: () => TRUTH,
          artefactKg: (d) => 1.2 * Math.sin((2 * Math.PI * (d + phase)) / 28) });
        for (const day of [42, 56, 84, 119]) {
          const r = night(scenario, day, 1873, 1338);
          const error = Math.abs((r.tdeeKcal as number) - TRUTH);
          expect(error, `phase ${phase} day ${day}`).toBeLessThanOrEqual(0.04 * TRUTH);
          if (r.proposalEligible) {
            eligible += 1;
            expect(error, `eligible phase ${phase} day ${day}`).toBeLessThanOrEqual(150);
          }
          if (day >= 84) {
            expect(Math.abs((r.fluidCycleDays ?? 0) - 28), `phase ${phase} day ${day}`)
              .toBeLessThanOrEqual(2);
          }
        }
      }
      expect(eligible).toBeGreaterThan(20);
    }, 60_000);
});

describe("step F trust — missing days hold the last estimate (R8)", () => {
  // Noise-free truth 2,100 kcal; logging stops on day `stop`, weigh-ins carry on.
  const gap = (stop: number) => buildScenario({ label: `gap-${stop}`, seed: 1, noiseKg: 0,
    noiseKcal: 0, tdee: () => 2100, intake: () => 2100, logged: (d) => d < stop });

  it.each([[1900, 50], [1900, 70], [2300, 50], [2300, 70]])(
    "seed %s, logging stops on day %s: never below 2,100 inside the lookback, then the seed",
    (seed, stop) => {
      const runs = replayScenario(gap(stop), { seedKcal: seed, bmrKcal: 1400 });
      const after = runs.filter((r) => toScenarioDay(r.date) > stop);
      const lastEstimate = runs.filter((r) => toScenarioDay(r.date) <= stop).at(-1)?.result;
      expect(lastEstimate).toMatchObject({ status: "estimating", tdeeKcal: 2100 });
      const firstHeld = after.findIndex((r) => r.result.status === "held");
      expect(firstHeld).toBeGreaterThan(0);
      for (const [i, run] of after.entries()) {
        const { status, tdeeKcal } = run.result;
        expect(status === "estimating" || status === "held", run.date).toBe(true);
        // Inside the lookback the number never moves, whichever side the seed is on.
        if (i < firstHeld + HELD_LOOKBACK_DAYS) expect(tdeeKcal, run.date).toBe(2100);
      }
      // R8, past the lookback: the starting estimate, so a seed below truth is a LOWER number.
      // The plan's "missing days → never a lower TDEE" holds only inside HELD_LOOKBACK_DAYS.
      expect(after.at(-1)?.result).toMatchObject({ status: "held", tdeeKcal: seed });
    });

  it("with the fixtures' noise, a held night shows exactly the last estimating night's number",
    () => {
      for (let seed = 0; seed < 5; seed += 1) {
        const runs = replayScenario(buildScenario({ label: `noisy-gap-${seed}`, seed: 300 + seed,
          tdee: () => 2130, intake: () => 2130, logged: (d) => d < 70 }),
        { seedKcal: 2000, bmrKcal: 1372 });
        const firstHeld = runs.findIndex((r) => r.result.status === "held");
        expect(firstHeld, `seed ${seed}`).toBeGreaterThan(0);
        const shown = runs[firstHeld - 1].result;
        expect(shown.status).toBe("estimating");
        for (const run of runs.slice(firstHeld, firstHeld + HELD_LOOKBACK_DAYS)) {
          expect(run.result, `${seed} ${run.date}`).toMatchObject({ status: "held",
            tdeeKcal: shown.tdeeKcal, proposalEligible: false });
        }
      }
    });
});

describe("step F trust — DST and runtime zones never move a day", () => {
  let savedTz: string | undefined;
  beforeEach(() => { savedTz = process.env.TZ; });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("day numbers are one apart across both 2026 U.S. and EU DST changes in any zone", () => {
    const edges = [["2026-03-07", "2026-03-08", "2026-03-09"], ["2026-03-28", "2026-03-29",
      "2026-03-30"], ["2026-10-24", "2026-10-25", "2026-10-26"], ["2026-10-31", "2026-11-01",
      "2026-11-02"]];
    for (const zone of ["UTC", "America/New_York", "Europe/London", "Pacific/Auckland",
      "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      for (const [a, b, c] of edges) {
        expect(toDayNumber(b) - toDayNumber(a), `${zone} ${a}`).toBe(1);
        expect(toDayNumber(c) - toDayNumber(b), `${zone} ${b}`).toBe(1);
        expect(fromDayNumber(toDayNumber(b)), zone).toBe(b);
      }
    }
  });

  it("the same scenario across a DST change gives identical nights in every runtime zone", () => {
    // Starts 2026-06-01 and runs 120 days, so it crosses no DST change; shift one that does.
    const scenario = buildScenario({ label: "dst", seed: 55, tdee: () => 2200,
      intake: () => 2000 });
    const shift = toDayNumber("2026-09-15") - toDayNumber(START_DATE);
    const moved = (date: string) => fromDayNumber(toDayNumber(date) + shift);
    const across: Scenario = { ...scenario, asOf: moved(scenario.asOf),
      intake: scenario.intake.map((d) => ({ ...d, date: moved(d.date) })),
      weighIns: scenario.weighIns.map((w) => ({ ...w, date: moved(w.date) })) };
    const nights = () => [40, 60, 90, 119].map((d) => {
      const end = toDayNumber(START_DATE) + shift + d;
      return estimateExpenditure({ asOf: fromDayNumber(end), seedKcal: 2100, bmrKcal: 1400,
        weighIns: across.weighIns.filter((w) => toDayNumber(w.date) < end),
        intake: across.intake.filter((i) => toDayNumber(i.date) < end) });
    });
    process.env.TZ = "UTC";
    const utc = nights();
    for (const zone of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      expect(nights(), zone).toEqual(utc);
    }
    // Shifting the calendar changes nothing either: only day differences enter the engine.
    process.env.TZ = "UTC";
    expect(utc.map((r) => r.tdeeKcal)).toEqual([40, 60, 90, 119]
      .map((d) => night(scenario, d, 2100, 1400).tdeeKcal));
  });
});

describe("step F trust — engine version reproduces its own numbers", () => {
  // status/phase/tdee/low-high/eligible on nights 20, 30, 42, 60, 90 and 119 of each scenario.
  // A change to any engine number must bump ENGINE_VERSION (old rows keep theirs; spec §Versioning)
  // and re-record this table in the same PR.
  const PINNED: Record<string, string> = {
    "steady state": "burn_in/provisional/2140/1880-2390/false estimating/adaptive/2120/1960-2280/false estimating/adaptive/2140/1990-2290/true estimating/adaptive/2080/1930-2230/true estimating/adaptive/2190/1990-2390/false estimating/adaptive/2130/1980-2280/true",
    "1.5 kg water swing over 3 days": "burn_in/provisional/2130/1880-2380/false estimating/adaptive/2130/1970-2290/false estimating/adaptive/2130/1980-2280/true estimating/adaptive/2100/1950-2250/true estimating/adaptive/2150/2000-2300/true estimating/adaptive/2140/1990-2290/true",
    "±0.8 kg on a 28-day cycle": "burn_in/provisional/2360/2110-2610/false estimating/adaptive/2350/1490-3210/false estimating/adaptive/2130/1690-2580/false estimating/adaptive/2130/1980-2280/false estimating/adaptive/2130/1980-2280/true estimating/adaptive/2110/1960-2260/true",
    "+250 kcal/day step": "burn_in/provisional/2140/1890-2390/false estimating/adaptive/2140/1980-2300/false estimating/adaptive/2140/1990-2290/true estimating/adaptive/2110/1960-2260/true estimating/adaptive/2350/2200-2500/true estimating/adaptive/2360/2210-2510/true",
    "+15 kcal/day/week ramp": "burn_in/provisional/2120/1870-2380/false estimating/adaptive/2120/1970-2280/false estimating/adaptive/2140/1990-2290/true estimating/adaptive/2180/1980-2370/false estimating/adaptive/2190/2040-2340/true estimating/adaptive/2190/2040-2340/true",
    "under-logging: 3 qualified days a week": "burn_in/provisional/2140/1890-2390/false estimating/adaptive/2140/1980-2300/false estimating/adaptive/2090/1940-2240/true estimating/adaptive/2130/1980-2280/true estimating/adaptive/2100/1950-2250/false held/provisional/2110/1960-2260/false",
  };

  it("is exp-3.1.0 and replays the six fixture scenarios to the recorded nights", () => {
    expect(ENGINE_VERSION).toBe("exp-3.1.0");
    expect(SCENARIOS.map((s) => s.label)).toEqual(Object.keys(PINNED));
    for (const scenario of SCENARIOS) {
      const line = [20, 30, 42, 60, 90, 119].map((d) => {
        const r = night(scenario, d);
        expect(r.engineVersion).toBe(ENGINE_VERSION);
        return `${r.status}/${r.phase}/${r.tdeeKcal}/${r.tdeeLowKcal}-${r.tdeeHighKcal}/${r.proposalEligible}`;
      }).join(" ");
      expect(line, scenario.label).toBe(PINNED[scenario.label]);
    }
  }, 30_000);
});
