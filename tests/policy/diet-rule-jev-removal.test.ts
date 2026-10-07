/**
 * Phase 18 W2c (docs/specs/phase-18-open-world-foods.md §10 W2c, D4, D9): Jev comes off the diet,
 * religious and profile rules, and the removal fails closed the same way W2a did for allergens.
 *
 * 1. For every preference flag and every frozen hard-rule facet, a food flagged only by Jev is
 *    never `allowed`, before or after, and a Jev `absent` no longer clears a food that has no
 *    deterministic evidence (it is `unverified`).
 * 2. A plain whole food that its class rules out stays `allowed` (the 2026-10-02 banana case).
 * 3. The impact report (scripts/diet-rule-jev-impact.ts) counts the moves per account, prints no
 *    food name or raw account id, and cannot write.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { FACETS, type Facet } from "@/lib/foods/facet-vocabulary";
import type { FoodFacetJudgments } from "@/lib/foods/facets";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";
import {
  EMPTY_PROFILE, evaluatePolicy, resolvePolicyVerdict, type ConstraintProfile, type PolicyEvidence,
} from "@/lib/policy/constraints";
import { dietFacetOutcome } from "@/lib/policy/diet-evidence";
import { FACET_RULES, type PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { preferenceMarks } from "@/lib/policy/preference-marks";
import { PROFILE_DEFINITIONS } from "@/lib/policy/profiles/catalog";
import { activeConfirmedHardMarks } from "@/lib/policy/profiles/hard-rules";
import { ruleId, type HardBasis, type RuleItem } from "@/lib/policy/profiles/types";
import {
  baseVerdict, combineVerdicts, legacyVerdict,
} from "@/scripts/diet-rule-jev-impact-legacy";

vi.mock("@/lib/server/admin", () => ({ adminClient: () => { throw new Error("no client in tests"); } }));
const {
  accountImpact, accountLabel, assertReportArgs, databasePorts, impactTotals, readOnlyClient, runReport,
} = await import("@/scripts/diet-rule-jev-impact");

const AS_OF = new Date("2026-10-05T12:00:00Z");
const judged = (facets: readonly Facet[], p: number): FoodFacetJudgments => Object.fromEntries(
  facets.map((facet) => [facet, { p, rubricVersion: 1, judgedAt: "2026-10-05T00:00:00Z" }]));

/** An Eats food with no deterministic diet evidence: no tag, no text, no category, not a whole food. */
function onlyJev(partial: Partial<PolicyEvidence> = {}): PolicyEvidence {
  return { foodRefId: "ref-1", allergenTags: null, category: null, onEatsList: true,
    onAvoidList: false, foodName: "Mystery snack mix", facetAction: "exclude", ...partial };
}

function hardItem(facet: string, basis: HardBasis, profileId = "p"): RuleItem {
  return { id: ruleId(profileId, facet), profileId, facet, strength: "never", hardBasis: basis,
    evidenceStrength: "strong", confirmation: "confirmed", expiresAt: null };
}

/** Every frozen facet a catalog profile makes a hard ("never", with a basis) rule of. */
const FACET_SET = new Set<string>(FACETS);
const HARD_RULE_FACETS = [...new Map([...PROFILE_DEFINITIONS.values()].flatMap((definition) =>
  definition.templates.filter((template) => template.strength === "never"
    && template.hardBasis !== null && FACET_SET.has(template.facet))
    .map((template) => [template.facet, template.hardBasis as HardBasis] as const))).entries()]
  .sort(([a], [b]) => a.localeCompare(b));

// A dense probability grid with both ends and a seeded sample.
let seed = 2;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const PS = [...Array.from({ length: 201 }, (_, i) => i / 200), ...Array.from({ length: 100 }, random)];

describe("acceptance 1: preference flags", () => {
  it("covers every preference flag", () => {
    expect(Object.keys(FACET_RULES).sort()).toEqual([...PREFERENCE_FLAGS].sort());
  });

  describe.each(PREFERENCE_FLAGS as readonly PolicyPreferenceFlag[])("%s", (flag) => {
    const facets = FACET_RULES[flag].map((rule) => rule.facet);
    const e = (p: number) => onlyJev({ preferenceFlags: [flag], facets: judged(facets, p) });

    it("a food flagged only by Jev is never allowed, before or after", () => {
      for (const facet of facets) {
        const evidence = onlyJev({ preferenceFlags: [flag], facets: judged([facet], 0.99) });
        expect(legacyVerdict(EMPTY_PROFILE, evidence), `before ${facet}`).not.toBe("allowed");
        expect(evaluatePolicy(EMPTY_PROFILE, evidence).verdict, `after ${facet}`).toBe("unverified");
      }
    });

    it("a Jev absent no longer clears a food without deterministic evidence", () => {
      expect(evaluatePolicy(EMPTY_PROFILE, e(0)).verdict).toBe("unverified");
    });

    it("for any facet probability the after-verdict is never allowed", () => {
      for (const p of PS) expect(evaluatePolicy(EMPTY_PROFILE, e(p)).verdict, `p=${p}`).not.toBe("allowed");
    });

    it("no mark comes from Jev", () => {
      expect(evaluatePolicy(EMPTY_PROFILE, e(0.99)).marks?.some((mark) => mark.source === "jev")).toBe(false);
    });
  });

  it("documents the change: where Jev alone used to clear, the food is now unverified", () => {
    for (const flag of ["pescatarian", "no_pork", "no_beef"] as const) {
      const evidence = onlyJev({ preferenceFlags: [flag], facets: judged(FACET_RULES[flag].map((r) => r.facet), 0) });
      expect(legacyVerdict(EMPTY_PROFILE, evidence), flag).toBe("allowed");
      expect(evaluatePolicy(EMPTY_PROFILE, evidence).verdict, flag).toBe("unverified");
    }
  });

  it("a tag list that omits a facet no longer clears it (before, a Jev present overrode it)", () => {
    const evidence = onlyJev({ allergenTags: [], preferenceFlags: ["no_eggs"],
      facets: judged(["contains_egg"], 0.99) });
    expect(legacyVerdict(EMPTY_PROFILE, evidence)).toBe("blocked");
    expect(evaluatePolicy(EMPTY_PROFILE, evidence).verdict).toBe("unverified");
  });
});

describe("acceptance 1: frozen hard-rule facets", () => {
  it("the catalog's frozen hard-rule facets are the ones this suite pins", () => {
    expect(HARD_RULE_FACETS.map(([facet]) => facet)).toEqual([
      "alcohol", "animal_product", "beef", "contains_dairy", "contains_egg", "contains_gluten",
      "contains_peanut", "contains_sesame", "contains_soy", "contains_tree_nut", "fish_seafood",
      "meat", "pork", "shellfish",
    ]);
  });

  describe.each(HARD_RULE_FACETS)("%s (%s)", (facet, basis) => {
    const rules = { items: [hardItem(facet, basis)], asOf: AS_OF };
    const e = (p: number) => onlyJev({ profileRules: rules, facets: judged([facet as Facet], p) });

    it("a food flagged only by Jev is never allowed, before or after", () => {
      expect(legacyVerdict(EMPTY_PROFILE, e(0.99))).toBe("blocked");
      expect(evaluatePolicy(EMPTY_PROFILE, e(0.99)).verdict).toBe("unverified");
    });

    it("a Jev absent no longer clears a food without deterministic evidence", () => {
      expect(legacyVerdict(EMPTY_PROFILE, e(0))).toBe("allowed");
      expect(evaluatePolicy(EMPTY_PROFILE, e(0)).verdict).toBe("unverified");
    });

    it("for any facet probability the after-verdict is never allowed", () => {
      for (const p of PS) expect(evaluatePolicy(EMPTY_PROFILE, e(p)).verdict, `p=${p}`).not.toBe("allowed");
    });
  });

  it("a held allergen row backing a diet facet keeps it unverified, even on a whole food", () => {
    const held = { level: "listed" as const, labelComplete: false, held: true as const };
    const rules = { items: [hardItem("fish_seafood", "religious")], asOf: AS_OF };
    expect(evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName: "Broccoli", profileRules: rules,
      allergenEvidence: { fish: held } })).verdict).toBe("unverified");
    expect(evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName: "Broccoli", profileRules: rules }))
      .verdict).toBe("allowed");
  });
});

describe("acceptance 2: a plain whole food its class rules out stays allowed", () => {
  const animalFlags = ["vegetarian", "vegan", "pescatarian", "no_pork", "no_beef", "no_shellfish"] as const;

  it("the 2026-10-02 banana case, for every animal preference and hard rule, whatever Jev says", () => {
    for (const p of [undefined, 0, 0.5, 0.99]) {
      const facets = p === undefined ? {} : judged(["meat", "pork", "beef", "animal_product",
        "fish_seafood", "shellfish", "alcohol"], p);
      for (const flag of animalFlags) {
        expect(evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName: "Banana, raw", preferenceFlags: [flag],
          facets })).verdict, `${flag} p=${p}`).toBe("allowed");
      }
      for (const facet of ["meat", "pork", "beef", "animal_product", "fish_seafood", "shellfish", "alcohol"]) {
        expect(evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName: "Banana", facets,
          profileRules: { items: [hardItem(facet, "religious")], asOf: AS_OF } })).verdict, facet)
          .toBe("allowed");
      }
    }
  });

  it("the class still blocks what it names, and clears only what it rules out", () => {
    const verdict = (foodName: string, flag: PolicyPreferenceFlag) =>
      evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName, preferenceFlags: [flag] })).verdict;
    expect(verdict("Salmon, cooked", "pescatarian")).toBe("allowed");
    expect(verdict("Chicken breast", "pescatarian")).toBe("blocked");
    expect(verdict("Eggs", "vegan")).toBe("blocked");
    expect(verdict("Eggs", "vegetarian")).toBe("allowed");
    expect(verdict("Sirloin steak", "no_pork")).toBe("allowed");
    expect(verdict("Shrimp", "kosher")).toBe("blocked");
    expect(verdict("Banana", "halal")).toBe("unverified"); // certification is still required
  });

  it("a complete label never clears an animal facet; it still blocks what it names (Option A)", () => {
    const label = (ingredientsText: string) => evaluatePolicy(EMPTY_PROFILE, onlyJev({
      foodName: "Rice crackers", ingredientsText, preferenceFlags: ["vegan"] })).verdict;
    expect(label("Water, rice flour, sunflower oil, salt.")).toBe("unverified");
    expect(label("Water, rice flour, natural flavor, salt.")).toBe("unverified");
    expect(label("Water, rice flour, honey, salt.")).toBe("blocked");
    expect(evaluatePolicy(EMPTY_PROFILE, onlyJev({ foodName: "Rice crackers", ingredientsTextIsLabel: false,
      ingredientsText: "Water, rice flour, sunflower oil, salt.", preferenceFlags: ["vegan"] })).verdict)
      .toBe("unverified");
  });

  it("a verified bundled starter's curated outcomes still decide (not Jev)", () => {
    expect(dietFacetOutcome("animal_product", { foodName: "Corn tortilla",
      attestedFacets: { animal_product: "absent" } })).toBe("absent");
    expect(dietFacetOutcome("animal_product", { foodName: "Corn tortilla" })).toBe("unknown");
    expect(dietFacetOutcome("animal_product", { foodName: "Whey protein powder",
      attestedFacets: { animal_product: "absent" } })).toBe("present");
  });
});

describe("no diet, religious or profile rule decision reads a Jev facet", () => {
  const root = path.join(process.cwd(), "lib/policy");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const readsFacets = (source: string) =>
    /from "@\/lib\/foods\/facets"|FoodFacetJudgments|facetOutcome\(|\.facets\b|facetAction/.test(source);

  it("the rule modules import no facet judgment and call no threshold", () => {
    for (const file of ["lib/policy/diet-evidence.ts", "lib/policy/preference-marks.ts",
      "lib/policy/profiles/hard-rules.ts", "lib/policy/profiles/new-facets.ts",
      "lib/policy/profiles/rank-context.ts"]) {
      expect(readsFacets(read(file)), file).toBe(false);
    }
  });

  it("constraints.ts reads e.facets only to pick the verdict's wire shape", () => {
    const source = read("lib/policy/constraints.ts");
    const uses = source.split("\n").filter((line) => /\be\.facets\b|\be\.facetAction\b/.test(line));
    expect(uses).toEqual([
      "  const enhanced = e.facetAction !== undefined || e.preferenceFlags !== undefined",
      "    || e.facets !== undefined || e.verifiedPreferenceFlags !== undefined",
    ]);
    expect(source).not.toMatch(/facetOutcome/);
  });

  it("only facet-rules.ts defines the threshold call, for non-rule judgments", () => {
    const callers = files(root).filter((file) => /facetOutcome\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file));
    expect(callers).toEqual(["lib/policy/facet-rules.ts"]);
  });

  it("no app path imports the pre-W2c logic kept for the offline report", () => {
    const appFiles = ["lib", "app", "components"].flatMap((dir) => files(path.join(process.cwd(), dir)));
    expect(appFiles.filter((file) => /from "@\/scripts\//.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});

describe("the legacy split reproduces today's verdict exactly (so the report's 'before' is sound)", () => {
  const profiles: ConstraintProfile[] = [EMPTY_PROFILE, { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] },
    { ...EMPTY_PROFILE, banned_categories: ["beans"] }];
  const foods: Partial<PolicyEvidence>[] = [
    { foodName: "Banana" }, { foodName: "Chicken breast" }, { foodName: "Mystery snack mix" },
    { foodName: "Rice crackers", ingredientsText: "Water, rice flour, sunflower oil, salt." },
    { foodName: "Black beans", allergenTags: [] }, { foodName: "Whole milk", onEatsList: false },
  ];
  const flagSets: PolicyPreferenceFlag[][] = [[], ["vegan"], ["no_pork", "low_fodmap"], ["halal"]];
  const ruleSets = [undefined, { items: [hardItem("meat", "religious")], asOf: AS_OF }];

  it("evaluatePolicy = combine(base, resolve(profile marks + preference marks))", () => {
    for (const profile of profiles) for (const food of foods) for (const flags of flagSets) {
      for (const profileRules of ruleSets) {
        const e = onlyJev({ ...food, preferenceFlags: flags, profileRules });
        const rules = resolvePolicyVerdict([...activeConfirmedHardMarks(profileRules, e),
          ...preferenceMarks(flags, new Set(), e)]);
        expect(evaluatePolicy(profile, e).verdict, JSON.stringify({ food, flags }))
          .toBe(combineVerdicts(baseVerdict(profile, e), rules.verdict));
      }
    }
  });
});

describe("acceptance 3: the read-only impact report", () => {
  const ready = (byIdentity: SuggestionEvidence["byIdentity"], flags: PolicyPreferenceFlag[]): SuggestionEvidence =>
    ({ status: "ready", preferenceFlags: flags, byIdentity });
  /** A catalog food with ingredient rows but no tag: before W2c the empty list "cleared" shellfish. */
  const facts = (foodName: string, facets: FoodFacetJudgments) => ({
    allergenTags: [], policyCategories: null, foodName, facets, noCook: null, onEatsList: true,
    onAvoidList: false, role: null,
  });
  const USER = "11111111-2222-4333-8444-555555555555";
  const items = [
    { foodRefId: "a", catalogFoodRevisionId: 1 }, { foodRefId: "b", catalogFoodRevisionId: 2 },
    { foodRefId: "c", catalogFoodRevisionId: 3 }, { foodRefId: "d", catalogFoodRevisionId: 4 },
  ];
  const vegan = judged(["animal_product", "meat", "fish_seafood", "shellfish"], 0);
  const evidence = ready({
    "ref:a": facts("Banana", vegan), // allowed before and after
    "ref:b": facts("Mystery snack mix", vegan), // Jev cleared it: allowed -> unverified
    "ref:c": facts("Granola clusters", vegan), // starred, Jev cleared it: allowed -> unverified
    "ref:d": facts("Chicken breast", vegan), // the name says meat: allowed (Jev) -> blocked
  }, ["vegan"]);

  it("counts each move per account", () => {
    const row = accountImpact({ userId: USER, items, unresolved: 1, favored: new Set(["c"]),
      profile: { ...EMPTY_PROFILE, profileRules: { items: [], asOf: AS_OF } }, evidence });
    expect(row).toMatchObject({ account: accountLabel(USER), eatsFoods: 5, unresolved: 1,
      favoredFoods: 1, preferenceFlags: 1, allowedBefore: 4, allowedAfter: 1, allowedToUnverified: 2,
      favoredAllowedToUnverified: 1, allowedToBlocked: 1, unverifiedToAllowed: 0, blockedToAllowed: 0,
      evidenceUnavailable: false });
    expect(impactTotals([row, row])).toMatchObject({ accounts: 2, accountsLosingAllowedFoods: 2,
      allowedToUnverified: 4, favoredAllowedToUnverified: 2 });
  });

  it("an unreadable account is reported as such, never as zero moves", () => {
    const row = accountImpact({ userId: USER, items, unresolved: 0, favored: new Set(),
      profile: EMPTY_PROFILE, evidence: { status: "unavailable", preferenceFlags: [], byIdentity: {} } });
    expect(row).toMatchObject({ evidenceUnavailable: true, allowedToUnverified: 0 });
  });

  it("prints counts only: a truncated account hash, no raw id and no food name", async () => {
    const lines: string[] = [];
    await runReport({
      accounts: async () => [USER, "empty-account"],
      eatsItems: async (id) => (id === USER ? { items, unresolved: 0 } : { items: [], unresolved: 0 }),
      favored: async () => new Set(["c", "not-an-eats-food"]),
      profile: async () => EMPTY_PROFILE,
      evidence: async () => evidence,
    }, (line) => lines.push(line));
    expect(lines).toHaveLength(2);
    const output = lines.join("\n");
    expect(output).toContain(`"account":"${accountLabel(USER)}"`);
    expect(accountLabel(USER)).toMatch(/^[0-9a-f]{12}$/);
    for (const secret of [USER, "Banana", "Mystery", "Granola", "Chicken", "ref:"]) {
      expect(output).not.toContain(secret);
    }
    expect(JSON.parse(lines[0])).toMatchObject({ favoredFoods: 1, allowedToUnverified: 2 });
    expect(JSON.parse(lines[1]).totals).toMatchObject({ accounts: 1, allowedToUnverified: 2 });
  });

  it("takes no argument: there is no write mode and no --production to opt into", () => {
    expect(() => assertReportArgs([])).not.toThrow();
    for (const flag of ["--production", "--fix", "--commit", "--write", "--review"]) {
      expect(() => assertReportArgs([flag]), flag).toThrow(/read-only/);
    }
  });

  it("its client refuses every write, rpc and auth surface, and still reads", async () => {
    const calls: string[] = [];
    const builder = Object.fromEntries(["select", "insert", "update", "upsert", "delete"].map((method) =>
      [method, (..._args: unknown[]) => { calls.push(method); return builder; }]));
    const raw = { from: () => builder, rpc: () => calls.push("rpc"), auth: {}, storage: {} };
    const db = readOnlyClient(raw as never);
    db.from("user_food_prefs").select("food_ref_id");
    for (const method of ["insert", "update", "upsert", "delete"] as const) {
      expect(() => (db.from("user_food_prefs") as never as Record<string, () => void>)[method](), method)
        .toThrow(/read-only/);
    }
    expect(() => db.rpc("anything" as never)).toThrow(/read-only/);
    expect(() => db.auth).toThrow(/read-only/);
    expect(() => db.storage).toThrow(/read-only/);
    expect(calls).toEqual(["select"]);
  });

  it("the production ports read through that client, and reading an account writes nothing", async () => {
    const calls: string[] = [];
    const rows: Record<string, unknown[]> = {
      user_settings: [{ user_id: USER }],
      user_food_prefs: [{ food_ref_id: "a" }, { food_ref_id: "u" }],
      food_refs: [{ id: "a", kind: "catalog", catalog_food_id: 9, user_food_id: null, user_foods: null },
        { id: "u", kind: "user", catalog_food_id: null, user_food_id: "uf", user_foods: { id: "uf", user_id: USER } }],
      catalog_food_revisions: [{ id: 90, catalog_food_id: 9 }],
      favorites_foods: [{ food_ref_id: "a" }],
    };
    const raw = { from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "order", "range"]) {
        chain[method] = () => { calls.push(`${table}.${method}`); return chain; };
      }
      for (const method of ["insert", "update", "upsert", "delete"]) {
        chain[method] = () => { calls.push(`${table}.${method}`); return chain; };
      }
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
      return chain;
    } };
    const ports = databasePorts(raw as never);
    expect(await ports.accounts()).toEqual([USER]);
    expect(await ports.eatsItems(USER)).toEqual({ unresolved: 0, items: [
      { foodRefId: "a", catalogFoodRevisionId: 90 }, { foodRefId: "u", catalogFoodRevisionId: null }] });
    expect([...await ports.favored(USER)]).toEqual(["a"]);
    expect(calls.some((call) => /\.(insert|update|upsert|delete)$/.test(call))).toBe(false);
  });

  it("the script source calls no write method at all", () => {
    for (const file of ["scripts/diet-rule-jev-impact.ts", "scripts/diet-rule-jev-impact-legacy.ts"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file)
        .not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    }
  });
});
