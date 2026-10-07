/**
 * Phase 18 W7 acceptance 4 ("Ranking never changes a safety verdict"): the `pref-2` module reaches
 * nothing under lib/policy, through any import, and returns no verdict field.
 *
 * Phase 18 hard rule H5, the snapshot-shape test (docs/specs/phase-18-open-world-foods.md D10, W1b
 * acceptance 7): race and ethnicity appear only in the offline fairness audit, never in a shipped
 * table, a meal snapshot or an account row. The snapshot parser keeps only its contract's fields,
 * so a smuggled axis does not survive it; the contract, the prior's cohort keys and the account
 * schema name no such axis.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRIOR_COHORTS } from "@/lib/foods/universe/prior";
import { OCCASIONS } from "@/lib/meals/occasion";
import { preferenceScores, tasteValues } from "@/lib/meals/preference";
import { parseMealSnapshot, RANKING_VERSION, SNAPSHOT_SCHEMA_VERSION } from "@/lib/meals/snapshot";

const SENSITIVE = /\brace\b|\bracial\b|ethnic|hispanic|RIDRETH/i;

const snapshot = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: RANKING_VERSION, accountId: "acct-1",
  computedAt: "2026-10-06T00:00:00.000Z", inputsHash: "h",
  foods: { f1: { userRefId: "u1", catalogRefId: null, parts: ["anchor"], family: null,
    occasion: Object.fromEntries(OCCASIONS.map((occasion) => [occasion, { score: 0.5, source: "neutral" }])) } },
};

describe("H5: no race or ethnicity axis reaches a snapshot, a cohort or an account row", () => {
  it("drops any extra axis at the snapshot boundary", () => {
    const parsed = parseMealSnapshot({ ...snapshot, raceEthnicity: "x",
      foods: { f1: { ...snapshot.foods.f1, ethnicity: "x" } } });
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toMatch(SENSITIVE);
  });

  it("the snapshot contract and the prior's cohorts name no such axis", () => {
    expect(readFileSync("lib/meals/snapshot.ts", "utf8")).not.toMatch(SENSITIVE);
    expect(PRIOR_COHORTS.filter((cohort) => SENSITIVE.test(cohort))).toEqual([]);
    expect(readFileSync("lib/foods/universe/prior.ts", "utf8")).not.toMatch(SENSITIVE);
  });

  it("no migration adds a race or ethnicity column", () => {
    const dir = "supabase/migrations";
    const hits = readdirSync(dir).filter((file) => file.endsWith(".sql"))
      .filter((file) => /\b\w*(race|ethnic|hispanic)\w*\s+(text|varchar|smallint|integer|int|boolean|jsonb)/i
        .test(readFileSync(path.join(dir, file), "utf8")));
    expect(hits).toEqual([]);
  });
});

/** Every project file a module reaches through static or dynamic imports (type imports included). */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? spec.slice(2)
      : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
    if (base === null) return null;
    for (const file of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (existsSync(file) && /\.tsx?$/.test(file)) return path.normalize(file);
    }
    for (const file of [`${base}.json`]) if (existsSync(file)) return path.normalize(file);
    throw new Error(`unresolved import ${spec} from ${from}`);
  };
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) return;
    const source = readFileSync(file, "utf8");
    const specs = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const spec of specs) {
      const next = resolve(file, spec);
      if (next) walk(next);
    }
  };
  walk(path.normalize(entry));
  return seen;
}

const VERDICT = /verdict|allowed|blocked|unverified|excluded|admit|avoid|policy|status/i;

function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysDeep(item, out);
    }
  }
  return out;
}

describe("W7 acceptance 4: pref-2 cannot touch a verdict", () => {
  it("reaches nothing under lib/policy through any import", () => {
    const closure = [...importClosure("lib/meals/preference.ts")];
    expect(closure).toContain(path.normalize("lib/meals/preference.ts"));
    expect(closure.filter((file) => file.split(path.sep).join("/").startsWith("lib/policy/"))).toEqual([]);
  });

  it("returns no verdict field, whatever the signals", () => {
    const scores = preferenceScores({ episodes: 3, foods: [
      { key: "shrimp", prior: 1, rules: -5, cuisineTiers: ["core"],
        signals: { favored: true, disliked: true, eaten: 3, chosen: 2, shop: 1, pantry: 1, notThis: { lunch: 2 } },
        neighbours: [{ key: "crab", k: 0.9, sensory: true }] },
      { key: "crab", signals: { disliked: true } },
    ] });
    const keys = [...keysDeep(scores), ...keysDeep(tasteValues(scores))];
    expect(keys.filter((key) => VERDICT.test(key))).toEqual([]);
    expect(JSON.stringify(scores)).not.toMatch(/"(?:verdict|allowed|blocked|unverified|avoid)"/i);
  });
});
