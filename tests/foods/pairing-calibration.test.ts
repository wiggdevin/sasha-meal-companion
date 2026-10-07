/**
 * Phase 18 W1c, acceptance 1 — the harness (docs/specs/phase-18-open-world-foods.md §5 "Jev pair
 * labels"). The gate itself is FROZEN until the owner labels the holdout by hand; these tests prove
 * the harness: the blinded, cuisine-balanced template; a loader that takes human labels only (Jev
 * never grades its own labels); and the calibration step with Brier, ECE, the reliability curve,
 * raw against calibrated, and the §5 gate.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CUISINES } from "@/lib/foods/universe/vocabulary";
import { calibrate, crossFitted, fitPlatt, GATE, scores } from "@/scripts/pairing/calibrate";
import {
  HOLDOUT_CSV, HOLDOUT_HEADER, holdoutShortfall, holdoutTemplate, MIN_LABELLED, parseHoldout, type HoldoutLoad,
} from "@/scripts/pairing/holdout";
import { fixedPairs, holdoutCandidates } from "@/scripts/pairing/pairs";
import { prng } from "@/scripts/priors/metrics";

const candidates = holdoutCandidates(fixedPairs());
const template = holdoutTemplate(candidates);

/** The template with labels filled in by `label(i)`. */
function filled(label: (i: number) => string, labeller = "DW"): string {
  const [header, ...lines] = template.trimEnd().split("\n");
  return [header, ...lines.map((line, i) => line.replace(/,,,$/, `,${label(i)},${labeller},`))].join("\n");
}

describe("the holdout template", () => {
  it("has at least 400 pairs, 36 in each of the 12 cuisines, no pair twice", () => {
    expect(candidates.length).toBeGreaterThanOrEqual(MIN_LABELLED);
    for (const cuisine of CUISINES) expect(candidates.filter((pair) => pair.cuisine === cuisine)).toHaveLength(36);
    expect(new Set(candidates.map((pair) => pair.id)).size).toBe(candidates.length);
  });

  it("is blinded: names, occasion and blank label columns only", () => {
    expect(template.split("\n")[0]).toBe(HOLDOUT_HEADER.join(","));
    expect(template).not.toMatch(/0\.\d{2}/);
  });

  it("the committed CSV is the current template and holds no label yet (acceptance 1 is frozen)", () => {
    const committed = readFileSync(HOLDOUT_CSV, "utf8");
    expect(committed).toBe(template);
    const load = parseHoldout(committed, candidates);
    expect(load.issues).toEqual([]);
    expect(load.labels).toEqual([]);
    expect(calibrate(load, new Map()).status).toBe("frozen");
  });
});

describe("the loader takes human labels only", () => {
  it.each(["Jev", "jev-latest", "TypeSafe", "GPT-6", "claude", "Gemini", "model", "AI", "auto"])("refuses labeller %s", (who) => {
    const load = parseHoldout(filled(() => "yes", who), candidates);
    expect(load.labels).toEqual([]);
    expect(load.issues.join()).toMatch(/names a model/);
  });

  it("refuses an edited pair, a changed header, an unknown label and a label with no labeller", () => {
    expect(parseHoldout(filled(() => "yes").replace("Butter", "Margarine"), candidates).issues.join()).toMatch(/edited/);
    expect(parseHoldout(filled(() => "yes").replace("labeller", "jev_p"), candidates).issues.join()).toMatch(/header/);
    expect(parseHoldout(filled(() => "maybe"), candidates).issues.join()).toMatch(/yes, no or unsure/);
    expect(parseHoldout(filled(() => "yes", ""), candidates).issues.join()).toMatch(/initials/);
  });

  it("counts yes/no only; unsure and blank rows do not reach the gate", () => {
    const load = parseHoldout(filled((i) => (i % 3 === 0 ? "unsure" : i % 2 ? "yes" : "no")), candidates);
    expect(load.unsure).toBe(144);
    expect(load.labels).toHaveLength(288);
    expect(holdoutShortfall(load).join()).toMatch(/at least 400/);
  });
});

describe("calibration and the §5 gate", () => {
  const humans = (seed: number) => {
    const random = prng(seed);
    return candidates.map(() => (random() < 0.55 ? 1 : 0));
  };

  it("scores Brier and a 10-bin ECE", () => {
    const result = scores([0.9, 0.9, 0.1, 0.1], [1, 0, 0, 0]);
    expect(result.brier).toBeCloseTo((0.01 + 0.81 + 0.01 + 0.01) / 4, 10);
    expect(result.ece).toBeCloseTo(0.5 * 0.4 + 0.5 * 0.1, 10);
    expect(result.curve.map((bin) => bin.observed)).toEqual([0, 0.5]);
  });

  it("a Platt fit recovers a known distortion", () => {
    const random = prng(3);
    const raw: number[] = [], labels: number[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const truth = random();
      labels.push(random() < truth ? 1 : 0);
      raw.push(1 / (1 + Math.exp(-(2 * Math.log(truth / (1 - truth)) + 1))));
    }
    const platt = fitPlatt(raw, labels);
    expect(platt.a).toBeCloseTo(0.5, 1);
    expect(platt.b).toBeCloseTo(-0.5, 1);
  });

  it("passes a raw Jev signal that is informative but underconfident, scored out of fold", () => {
    const y = humans(11);
    const random = prng(12);
    const csv = filled((i) => (y[i] ? "yes" : "no"));
    const load = parseHoldout(csv, candidates);
    expect(holdoutShortfall(load)).toEqual([]);
    const raw = new Map(candidates.map((pair, i) => [pair.id, 0.5 + (2 * y[i] - 1) * 0.12 + (random() - 0.5) * 0.1]));
    const result = calibrate(load, raw);
    expect(result.status).toBe("pass");
    expect(result.calibrated!.brier).toBeLessThanOrEqual(GATE.brier);
    expect(result.calibrated!.ece).toBeLessThanOrEqual(GATE.ece);
    expect(result.raw!.brier - result.calibrated!.brier).toBeGreaterThanOrEqual(GATE.gain);
    expect(result.raw!.curve.length).toBeGreaterThan(1);
    expect(result.perCuisine).toHaveLength(12);
  });

  it("fails a raw signal with no information, and freezes when Jev labels are missing", () => {
    const y = humans(21);
    const random = prng(22);
    const load = parseHoldout(filled((i) => (y[i] ? "yes" : "no")), candidates);
    const noise = new Map(candidates.map((pair) => [pair.id, random()]));
    expect(calibrate(load, noise).status).toBe("fail");
    const partial = new Map([...noise].slice(0, 300));
    expect(calibrate(load, partial).status).toBe("frozen");
  });

  it("cross-fitting scores every pair with a calibrator fitted without it", () => {
    const rows = candidates.slice(0, 50).map((pair, i) => ({ id: pair.id, p: i % 2 ? 0.8 : 0.3, y: i % 2 }));
    expect(crossFitted(rows)).toHaveLength(50);
    const load: HoldoutLoad = { labels: [], unsure: 0, blank: 432, issues: [] };
    expect(calibrate(load, new Map()).reasons.join()).toMatch(/at least 400/);
  });
});
