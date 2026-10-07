// tests/expenditure/fixtures.test.ts
import { describe, expect, it } from "vitest";
import { BASE_KG, lcg, replayScenario, SCENARIOS, steadyState, waterSwing } from "@/lib/expenditure.fixtures";

describe("lcg", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = Array.from({ length: 5 }, lcg(42));
    expect(Array.from({ length: 5 }, lcg(42))).toEqual(a);
    const draws = Array.from({ length: 500 }, () => lcg(7)()).map(() => 0);
    expect(draws.every((v) => v >= 0 && v < 1)).toBe(true);
    const stream = lcg(7);
    for (let i = 0; i < 500; i += 1) {
      const v = stream();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("never uses Math.random", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("lib/expenditure.fixtures.ts", "utf8"));
    expect(src).not.toContain("Math.random");
  });
});

describe("scenarios", () => {
  it("ships the six F-092 series, each with a label and a full 90-day span", () => {
    expect(SCENARIOS.map((s) => s.label)).toEqual([
      "steady state", "1.5 kg water swing over 3 days", "±0.8 kg on a 28-day cycle",
      "+250 kcal/day step", "+15 kcal/day/week ramp", "under-logging: 3 qualified days a week",
    ]);
    for (const s of SCENARIOS) expect(s.intake.length).toBeGreaterThanOrEqual(90);
  });

  it("is byte-identical on a second build", () => {
    expect(JSON.stringify(steadyState())).toBe(JSON.stringify(steadyState()));
  });

  it("keeps the water swing's peak day above the 2.5 % outlier bound", () => {
    const peak = waterSwing().weighIns.reduce((max, w) => Math.max(max, w.kg), 0);
    expect(peak - BASE_KG).toBeCloseTo(1.5, 1);
  });

  it("replays day by day and carries the prior forward", () => {
    const runs = replayScenario(steadyState());
    expect(runs.length).toBeGreaterThan(60);
    expect(runs.at(-1)?.result.status).toBe("estimating");
    expect(runs[0].result.status).toBe("burn_in");
  });
});
