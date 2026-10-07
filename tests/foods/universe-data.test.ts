/**
 * Phase 18 W1, acceptance 1 (docs/specs/phase-18-open-world-foods.md): every universe item, 100 %
 * of them, carries one SR Legacy identity, usable nutrition, a plate part, non-NULL
 * `policy_categories`, vocabulary-only tags, and a deterministic allergen state for every key in
 * ALLERGEN_RULES (or a declared `unknown`). Plus the version pin, the receipt, and inertness.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POLICY_CATEGORY_KEYS } from "@/lib/catalog/category-map";
import { dbFood } from "@/lib/food-db";
import { EXCLUDED } from "@/lib/foods/universe/data/excluded";
import { PACKS } from "@/lib/foods/universe/data/packs";
import { ALLERGEN_KEYS, deriveItem, universePolicyEvidence, type UniverseItem } from "@/lib/foods/universe/derive";
import {
  UNIVERSE, UNIVERSE_HASH, UNIVERSE_VERSION, universeContentHash,
} from "@/lib/foods/universe/manifest";
import { CUISINES, SENSORY_TAGS, TIERS } from "@/lib/foods/universe/vocabulary";
import { macroKcal } from "@/lib/scaling";
import { ALLERGEN_RULES, deriveEvidence } from "@/lib/policy/allergens";
import { EMPTY_PROFILE, evaluatePolicy } from "@/lib/policy/constraints";
import { admissionEvidence } from "@/lib/foods/world/admission";
import { MATRIX_SPLIT, RULE_PROFILES, universeVerdict } from "@/tests/helpers/universe-matrix";

const items = UNIVERSE.map((entry) => deriveItem(entry));
const derived = items.filter((item): item is UniverseItem => item !== null);
const ids = (rows: readonly UniverseItem[]) => rows.map((item) => item.entry.id);
/** D1's excluded groups: sweets, drinks, condiments, the supplement and prepared meal rows. */
const EXCLUDED_GROUPS = new Set(["sweet", "drink", "condiment", "supplement", "meal"]);
/** An all-caps word of 3+ letters in an SR description is a brand (USDA's own name aside). */
const BRAND = /\b(?!USDA\b)[A-Z]{3,}\b/;

describe("universe v1 identity and version", () => {
  it("holds between 250 and 600 items, each derived from its bundled row", () => {
    expect(UNIVERSE.length).toBeGreaterThanOrEqual(250);
    expect(UNIVERSE.length).toBeLessThanOrEqual(600);
    expect(derived).toHaveLength(UNIVERSE.length);
  });

  it("maps every item to one SR Legacy food, and no two items to the same one", () => {
    expect(new Set(UNIVERSE.map((entry) => entry.id)).size).toBe(UNIVERSE.length);
    expect(new Set(UNIVERSE.map((entry) => entry.fdcId)).size).toBe(UNIVERSE.length);
    for (const item of derived) {
      expect([item.entry.id, item.row.fdcId]).toEqual([item.entry.id, item.entry.fdcId]);
      expect([item.entry.id, item.row.sr.startsWith("label:")]).toEqual([item.entry.id, false]);
      expect([item.entry.id, typeof item.row.srCategory]).toEqual([item.entry.id, "string"]);
    }
  });

  it("keeps generic, unbranded foods only, and nothing from the excluded groups or list", () => {
    const excluded = new Set(Object.values(EXCLUDED).flat());
    for (const id of excluded) expect([id, dbFood(id) !== undefined]).toEqual([id, true]);
    for (const item of derived) {
      expect([item.entry.id, BRAND.test(item.row.sr)]).toEqual([item.entry.id, false]);
      expect([item.entry.id, excluded.has(item.entry.id)]).toEqual([item.entry.id, false]);
      expect([item.entry.id, EXCLUDED_GROUPS.has(item.row.category)]).toEqual([item.entry.id, false]);
    }
  });

  it("pins its content hash to a semver version with a review receipt naming the reviewer", () => {
    expect(UNIVERSE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(universeContentHash()).toBe(UNIVERSE_HASH);
    const receipt = `docs/catalog/universe/${UNIVERSE_VERSION}.md`;
    expect(existsSync(receipt)).toBe(true);
    const text = readFileSync(receipt, "utf8");
    expect(text).toContain(UNIVERSE_HASH);
    expect(text).toContain("GPT-6 Sol automated evidence review (2026-10-05); owner review: pending");
  });
});

describe("universe v1 data, for 100 % of items", () => {
  it("has finite, non-negative macros and positive energy", () => {
    for (const { entry, row } of derived) {
      const { kcal, protein, carbs, fat } = row.per100g;
      for (const value of [kcal, protein, carbs, fat]) {
        expect([entry.id, Number.isFinite(value) && value >= 0]).toEqual([entry.id, true]);
      }
      expect([entry.id, kcal > 0 && macroKcal({ protein, carbs, fat }) > 0]).toEqual([entry.id, true]);
    }
  });

  it("plays at least one plate part", () => {
    for (const item of derived) expect([item.entry.id, item.parts.length > 0]).toEqual([item.entry.id, true]);
  });

  it("carries non-NULL policy_categories from the controlled keys", () => {
    for (const item of derived) {
      expect(Array.isArray(item.policyCategories)).toBe(true);
      for (const key of item.policyCategories) expect(POLICY_CATEGORY_KEYS).toContain(key);
    }
  });

  it("uses vocabulary-only cuisine tiers and sensory tags", () => {
    for (const { entry } of derived) {
      for (const [cuisine, tier] of Object.entries(entry.tiers)) {
        expect(CUISINES).toContain(cuisine);
        expect(TIERS).toContain(tier);
      }
      for (const tag of entry.sensory) expect(SENSORY_TAGS).toContain(tag);
      expect(typeof entry.countable).toBe("boolean");
    }
  });

  it("has a deterministic allergen state for every key in ALLERGEN_RULES", () => {
    expect(ALLERGEN_KEYS).toEqual(Object.keys(ALLERGEN_RULES));
    for (const item of derived) {
      expect(Object.keys(item.allergens).sort()).toEqual([...ALLERGEN_KEYS].sort());
      for (const state of Object.values(item.allergens)) expect(["listed", "clear", "unknown"]).toContain(state);
    }
  });

  it("agrees with evaluatePolicy for an account avoiding each allergen alone", () => {
    const verdictOf = { listed: "blocked", clear: "allowed", unknown: "unverified" } as const;
    const rank = { listed: 2, unknown: 1, clear: 0 } as const;
    for (const item of derived) {
      for (const key of ALLERGEN_KEYS.filter((name) => name !== "crustacean")) {
        // Avoiding shellfish also judges the FALCPA crustacean key (withCrustaceanAllowance).
        const states = [item.allergens[key], ...(key === "shellfish" ? [item.allergens.crustacean] : [])];
        const worst = states.sort((a, b) => rank[b] - rank[a])[0];
        const verdict = evaluatePolicy({ ...EMPTY_PROFILE, avoid_allergens: [key] }, universePolicyEvidence(item));
        expect([item.entry.id, key, verdict.verdict]).toEqual([item.entry.id, key, verdictOf[worst]]);
      }
    }
  });

  it("reads no Jev facet, and every name-based listing is one the SR description stores too", () => {
    for (const item of derived) {
      expect(universePolicyEvidence(item).facets).toBeUndefined();
      for (const key of ALLERGEN_KEYS) {
        const byName = deriveEvidence(key, { ingredientsText: null, labelComplete: false, foodName: item.row.name });
        const bySr = deriveEvidence(key, { ingredientsText: null, labelComplete: false, foodName: item.row.sr });
        if (byName.level === "listed") expect([item.entry.id, key, bySr.level]).toEqual([item.entry.id, key, "listed"]);
      }
    }
  });
});

describe("cuisine packs", () => {
  it("tier 30 to 60 universe items per cuisine, each once, and place every pack staple", () => {
    const universe = new Set(ids(derived));
    for (const cuisine of CUISINES) {
      const listed = TIERS.flatMap((tier) => PACKS[cuisine][tier]);
      expect([cuisine, new Set(listed).size]).toEqual([cuisine, listed.length]);
      expect(listed.length).toBeGreaterThanOrEqual(30);
      expect(listed.length).toBeLessThanOrEqual(60);
      for (const id of listed) expect([cuisine, id, universe.has(id)]).toEqual([cuisine, id, true]);
    }
    for (const entry of UNIVERSE.filter((row) => row.layer === "pack")) {
      expect([entry.id, Object.keys(entry.tiers).length > 0]).toEqual([entry.id, true]);
    }
  });

  it("covers all 12 cuisines in the matrix split", () => {
    expect([...MATRIX_SPLIT.flat()].sort()).toEqual([...CUISINES].sort());
  });
});

describe("matrix admission (D4)", () => {
  it("admits only a raw `allowed`: no profile turns `unverified` into `allowed`", () => {
    for (const rules of RULE_PROFILES) {
      for (const item of derived.filter((row) => universeVerdict(rules, row) === "allowed")) {
        const raw = evaluatePolicy(rules.profile, { ...admissionEvidence(item), preferenceFlags: rules.flags });
        expect([rules.key, item.entry.id, raw.verdict]).toEqual([rules.key, item.entry.id, "allowed"]);
      }
    }
  });

  it("admits, for each allergen profile, only items clear of every avoided allergen", () => {
    for (const rules of RULE_PROFILES.filter((row) => row.profile.avoid_allergens.length > 0)) {
      const keys = rules.profile.avoid_allergens.flatMap((key) => (key === "shellfish" ? [key, "crustacean"] : [key]));
      for (const item of derived.filter((row) => universeVerdict(rules, row) === "allowed")) {
        for (const key of keys) expect([rules.key, item.entry.id, key, item.allergens[key]]).toEqual([rules.key, item.entry.id, key, "clear"]);
      }
    }
  });
});

describe("inert until the W2b gate opens", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

  /**
   * Phase 18 W3 (D5) names eaten foods by universe item and judges a universe-only identity for
   * the taste history. Neither path generates, suggests or admits a food anywhere: these readers
   * only label history.
   */
  const IDENTITY_READERS = [path.join("lib", "meals", "taste-identity.ts"),
    path.join("lib", "server", "taste-admission.ts"),
    // D6 Favor: checks that a u: key names a universe item; it writes only the caller's own refs.
    path.join("lib", "server", "taste-favor.ts")];
  /**
   * Phase 18 W1c: the pairing loader, gate and schema import only the NCHS ruling constants and the
   * ruling hash function from lib/foods/universe (prior.ts, artifacts.ts). They read no universe food
   * data, and nothing outside lib/foods/pairing imports them yet (W8 wires them in).
   */
  const NCHS_GATE_READERS = ["artifacts", "gate", "schema"].map((name) => path.join("lib", "foods", "pairing", `${name}.ts`));
  /**
   * Phase 18 W5: the stored cuisines and taste dislikes are checked against the fixed word lists in
   * lib/foods/universe/vocabulary.ts (the 12 cuisines, the sensory tags). They import that module
   * only, and read no universe food.
   */
  const VOCABULARY_READERS = ["cuisines", "taste"].map((name) => path.join("lib", "profile", `${name}.ts`));
  /**
   * Phase 18 W5b (D9 item 3): the taste-chip family list reads universe NAMES only, so Jev is asked
   * only about a family the user wrote and a chip can only carry a family the universe knows. It
   * proposes chips the user confirms; it never generates, suggests or admits a food, and nothing on
   * a generating path imports it (checked below).
   */
  const FAMILY_READERS = [path.join("lib", "profile", "taste-families.ts")];

  it("the W5 vocabulary readers import the vocabulary and nothing else from lib/foods/universe", () => {
    for (const file of VOCABULARY_READERS) {
      const imports = [...readFileSync(file, "utf8").matchAll(/["']@\/lib\/foods\/universe\/([^"']+)["']/g)].map((m) => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      expect([...new Set(imports)]).toEqual(["vocabulary"]);
    }
  });

  it("is imported only by the W2b gate, the W8 open-world readers, the W3 history readers and the W1c NCHS gate readers outside lib/foods/universe", () => {
    // W2b: the D4 admission order reads it, for an open account only (no account opens yet). W8:
    // snapshot v3 and the open-world pool read it, again only for an open account.
    const GATE = [path.join("lib", "foods", "world", "admission.ts"), path.join("lib", "server", "candidate-foods.ts"),
      path.join("lib", "foods", "world", "plate-evidence.ts"), path.join("lib", "foods", "world", "snapshot-foods.ts"),
      path.join("lib", "foods", "world", "taste-inputs.ts"), path.join("lib", "meals", "open-world.ts"),
      path.join("lib", "server", "meal-snapshot-v3.ts"),
      // The shared wire contract (phone and server): `snapshotV3Usable` compares a held body's
      // universeVersion/universeHash against this build's own (Sol r1 BLOCK), for an open account
      // only. The comment above already named this file; the array had not caught up to it.
      path.join("lib", "meals", "snapshot-v3.ts")];
    const readers = ["app", "components", "lib"].flatMap(files)
      .filter((file) => !file.startsWith(path.join("lib", "foods", "universe")))
      .filter((file) => !IDENTITY_READERS.includes(file))
      .filter((file) => !NCHS_GATE_READERS.includes(file))
      .filter((file) => !VOCABULARY_READERS.includes(file))
      .filter((file) => !FAMILY_READERS.includes(file))
      .filter((file) => readFileSync(file, "utf8").includes("lib/foods/universe"));
    expect(readers.sort()).toEqual(GATE.sort());
  });

  it("the W5b family reader imports only the manifest, and no generating module imports it", () => {
    const imports = [...readFileSync(FAMILY_READERS[0], "utf8").matchAll(/["']@\/lib\/foods\/universe\/([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["manifest"]);
    const importers = ["app", "components", "lib"].flatMap(files)
      .filter((file) => readFileSync(file, "utf8").includes("profile/taste-families"));
    for (const file of importers) expect([file, /^(app|components)/.test(file)]).toEqual([file, false]);
    for (const file of ["lib/meals/plate.ts", "lib/meals/size.ts", "lib/meals/day.ts", "lib/meals/pool.ts",
      "lib/resolve.ts", "lib/server/eligible-foods.ts", "lib/server/meal-snapshot.ts", "lib/coach/suggest.ts",
      "lib/server/candidate-foods.ts", "lib/foods/world/admission.ts"]) {
      expect([file, readFileSync(file, "utf8").includes("taste-families")]).toEqual([file, false]);
    }
  });

  it("reaches no generating module through the W3 taste-history readers", () => {
    const generators = ["lib/meals/plate.ts", "lib/meals/size.ts", "lib/meals/day.ts", "lib/meals/pool.ts",
      "lib/resolve.ts", "lib/server/eligible-foods.ts", "lib/server/meal-snapshot.ts", "lib/coach/suggest.ts"];
    for (const file of generators) {
      expect(readFileSync(file, "utf8")).not.toMatch(/meals\/taste|server\/taste-/);
    }
  });
});
