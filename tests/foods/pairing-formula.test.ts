/**
 * Phase 18 W1c, acceptance 4 and 5 (docs/specs/phase-18-open-world-foods.md D8 part 5): a curated
 * "not with this" pair stays excluded and no feature moves a scored pair below the 0.3 floor; with
 * the Jev weight at 0 the bundled table equals the table built without Jev labels; and (round 2)
 * with the co weight at 0 it equals the table built with no co term, so every curated score stands.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePairingTable } from "@/lib/foods/pairing/schema";
import {
  adjustedPair, buildPairingTable, PAIR_CO_TARGET_WEIGHT, PAIRING_CURATED_SHA256, PAIR_FLOOR, PAIR_JEV_TARGET_WEIGHT, PAIR_WEIGHTS, pairingIndex, pairKey, PAIRING_DIR,
  pairWithFeatures, TABLE_FILE,
} from "@/lib/foods/pairing/table";
import { PAIR_FLOOR as MEALS_FLOOR } from "@/lib/meals/affinity";
import { readCoFeatures, pairingText } from "@/scripts/pairing/artifact-io";
import { curatedHash, fixedPairs } from "@/scripts/pairing/pairs";
import { prng } from "@/scripts/priors/metrics";

const pairs = fixedPairs();
const committedText = readFileSync(path.join(PAIRING_DIR, TABLE_FILE), "utf8");
const committed = parsePairingTable(JSON.parse(committedText))!;
const co = readCoFeatures();
/** The table at the co target weight: never shipped, used to exercise the formula on real rows. */
const preview = buildPairingTable(pairs, { co, jev: null, comp: null }, { ...PAIR_WEIGHTS, co: PAIR_CO_TARGET_WEIGHT });

describe("acceptance 4: the floor and curated exclusions", () => {
  it("uses the meal engine's floor", () => {
    expect(PAIR_FLOOR).toBe(MEALS_FLOOR);
  });

  it("returns a curated exclusion unchanged whatever the features say", () => {
    for (const features of [{ co: 1, jev: 1, comp: 1 }, { co: 0 }, {}]) {
      expect(pairWithFeatures(0.1, features, { co: 0.2, jev: 0.15, comp: 0.05 })).toBe(0.1);
    }
  });

  it("never moves a scored pair below the floor or above 1 (random property)", () => {
    const random = prng(7);
    for (let i = 0; i < 5000; i += 1) {
      const b = PAIR_FLOOR + random() * (1 - PAIR_FLOOR);
      const value = pairWithFeatures(b, { co: random(), jev: random(), comp: random() }, { co: random(), jev: random(), comp: random() });
      expect(value).toBeGreaterThanOrEqual(PAIR_FLOOR);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(pairWithFeatures(0.32, { co: 0 }, { co: 1, jev: 0, comp: 0 })).toBe(PAIR_FLOOR);
  });

  it("has curated exclusions in the fixed list, and none of them has a table row", () => {
    const excluded = pairs.filter((pair) => pair.b < PAIR_FLOOR);
    expect(excluded.length).toBeGreaterThan(100);
    const index = pairingIndex(committed);
    for (const pair of excluded) {
      expect(index.has(pairKey(pair.anchor, pair.side, pair.template))).toBe(false);
      expect(adjustedPair(index, committed, pair.anchor, pair.side, pair.template, pair.b)).toBe(pair.b);
    }
  });

  it("at the co target weight every row stays at or above the floor and follows the formula", () => {
    expect(preview.rows.length).toBeGreaterThan(1000);
    for (const row of preview.rows) {
      expect(row.pair).toBeGreaterThanOrEqual(PAIR_FLOOR);
      expect(row.pair).toBe(pairWithFeatures(row.b, { co: row.co, jev: row.jev, comp: row.comp }, preview.weights));
    }
  });

  it("an account's history B (≥ 0.85) is adjusted from the same features, still within [floor, 1]", () => {
    const index = pairingIndex(preview);
    const row = preview.rows.find((item) => item.b < 0.85)!;
    const value = adjustedPair(index, preview, row.anchor, row.side, row.template, 0.85);
    expect(value).toBe(pairWithFeatures(0.85, { co: row.co }, preview.weights));
    expect(adjustedPair(index, preview, "no-family", "rice", "main", 0.6)).toBe(0.6);
  });
});

describe("acceptance 5: the Jev weight at 0", () => {
  const jev = new Map(pairs.slice(0, 500).map((pair) => [pairKey(pair.anchor, pair.side, pair.template), 0.9] as const));

  it("ships at 0, with 0.15 as the target only", () => {
    expect(PAIR_WEIGHTS.jev).toBe(0);
    expect(PAIR_JEV_TARGET_WEIGHT).toBe(0.15);
    expect(committed.weights.jev).toBe(0);
    expect(committed.absent).toContain("jev");
    expect(committed.rows.some((row) => row.jev !== undefined)).toBe(false);
  });

  it("gives the same bytes with and without Jev labels", () => {
    const withJev = buildPairingTable(pairs, { co, jev, comp: null });
    const without = buildPairingTable(pairs, { co, jev: null, comp: null });
    expect(pairingText(withJev)).toBe(pairingText(without));
  });

  it("the committed table is the table built without Jev labels", () => {
    expect(pairingText(buildPairingTable(pairs, { co, jev: null, comp: null }))).toBe(committedText);
  });

  it("would differ once the weight leaves 0 (the check has teeth)", () => {
    const weights = { ...PAIR_WEIGHTS, jev: PAIR_JEV_TARGET_WEIGHT };
    expect(pairingText(buildPairingTable(pairs, { co, jev, comp: null }, weights)))
      .not.toBe(pairingText(buildPairingTable(pairs, { co, jev: null, comp: null }, weights)));
  });
});

describe("round 2: the co weight at 0", () => {
  it("pins the curated scores the table was built on", () => {
    expect(curatedHash(pairs)).toBe(PAIRING_CURATED_SHA256);
  });

  it("ships at 0, with 0.2 as the target only, and the co data stays in its own artifact", () => {
    expect(PAIR_WEIGHTS.co).toBe(0);
    expect(PAIR_CO_TARGET_WEIGHT).toBe(0.2);
    expect(committed.weights.co).toBe(0);
    expect(committed.absent).toContain("co");
    expect(committed.rows).toEqual([]);
    expect(co.size).toBeGreaterThan(1000);
  });

  it("gives the same bytes as the table built with no co term, and the committed table is that table", () => {
    const withCo = pairingText(buildPairingTable(pairs, { co, jev: null, comp: null }));
    const without = pairingText(buildPairingTable(pairs, { co: null, jev: null, comp: null }));
    expect(withCo).toBe(without);
    expect(committedText).toBe(without);
  });

  it("leaves every curated score unchanged: lamb with couscous stays 1", () => {
    const index = pairingIndex(committed);
    const lamb = pairs.find((pair) => pair.anchor === "lamb" && pair.side === "couscous-cooked" && pair.template === "main")!;
    expect(lamb.b).toBe(1);
    expect(co.get(pairKey("lamb", "couscous-cooked", "main"))).toBe(0);
    expect(adjustedPair(index, committed, "lamb", "couscous-cooked", "main", lamb.b)).toBe(1);
    for (const pair of pairs) expect(adjustedPair(index, committed, pair.anchor, pair.side, pair.template, pair.b)).toBe(pair.b);
    expect(adjustedPair(pairingIndex(preview), preview, "lamb", "couscous-cooked", "main", 1)).toBe(0.8);
  });
});
