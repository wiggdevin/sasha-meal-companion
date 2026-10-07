import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allergenFinding } from "@/lib/policy/allergens";
import {
  fetchAllRows, findContradictions, finiteProbability, PAGE_SIZE, redactedFoodKey, userFoodInfoKey,
  type EvidenceRow, type FoodInfo,
} from "@/scripts/allergen-evidence-repair";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), adminClient: vi.fn(), createUser: vi.fn(), deleteUser: vi.fn(),
}));

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => mocks.adminClient(),
}));

const { assertWriteTarget, main, projectRef } = await import("@/scripts/allergen-evidence-repair");

const PRODUCTION_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
const BRANCH_URL = "https://abcdefghijklmnopqrst.supabase.co";
const USER_FOOD_ID = "11111111-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-10-03T15:04:13.35+00:00";

function row(partial: Partial<EvidenceRow>): EvidenceRow {
  return { food_key: "catalog_revision:1", allergen: "gluten", level: "listed", label_complete: false,
    source: "jev", user_id: null, updated_at: UPDATED_AT, ...partial };
}

/**
 * Grok audit (2026-10-03, BLOCKER): PostgREST caps a plain select at 1000 rows with no signal
 * that it happened. Every multi-row read in this script must page past that until a short page,
 * never trust a single select to be complete.
 */
describe("fetchAllRows (pagination)", () => {
  it("pages past a full first page until a short page ends it", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => i);
    const extra = [PAGE_SIZE, PAGE_SIZE + 1];
    const calls: { from: number; to: number }[] = [];
    const page = async (from: number, to: number) => {
      calls.push({ from, to });
      return from === 0 ? { data: full, error: null } : { data: extra, error: null };
    };
    const out = await fetchAllRows(page);
    expect(out).toEqual([...full, ...extra]);
    expect(calls).toEqual([{ from: 0, to: PAGE_SIZE - 1 }, { from: PAGE_SIZE, to: 2 * PAGE_SIZE - 1 }]);
  });

  it("stops after one page when it is already short, and surfaces a read error", async () => {
    expect(await fetchAllRows(async () => ({ data: [1, 2, 3], error: null }))).toEqual([1, 2, 3]);
    await expect(fetchAllRows(async () => ({ data: null, error: { message: "boom" } })))
      .rejects.toThrow("boom");
  });

  /**
   * DeepSeek audit round 2 (MAJOR): a server/proxy that ignores `.range()` and always returns a
   * full page must not spin this loop forever — it has to stop with a loud error instead.
   */
  it("throws rather than looping forever when every page comes back full", async () => {
    await expect(fetchAllRows(async () =>
      ({ data: Array.from({ length: PAGE_SIZE }, (_, i) => i), error: null })))
      .rejects.toThrow(/exceeded .* pages/);
  });
});

/** A chainable mock PostgREST builder: every method returns itself; `.then` resolves `result`. */
function mockBuilder(result: { data: unknown[] | null; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order"]) builder[method] = () => builder;
  builder.range = () => Promise.resolve(result);
  return builder;
}

/**
 * Grok audit round 4 (BLOCKER): a catalog ingredient row's `raw_text` and `name` can both carry
 * real content that differs — picking only one (the display-oriented join every other caller
 * uses) can drop the only on-file statement naming the allergen. This exercises the real DB-wired
 * path (`loadContradictions`), not just the pure core, because the bug was specifically in how
 * `loadFoodInfo` built the text it hands to that core.
 */
describe("loadContradictions: the catalog ingredient text veto reads both raw_text and name", () => {
  it("never deletes a row whose allergen is named only in the parsed ingredient name, " +
    "not the verbatim raw_text", async () => {
    const { loadContradictions } = await import("@/scripts/allergen-evidence-repair");
    const evidenceRow = { food_key: "catalog_revision:42", allergen: "gluten", level: "listed",
      label_complete: false, source: "jev", user_id: null, updated_at: UPDATED_AT };
    const admin = {
      from: (table: string) => {
        if (table === "food_allergen_evidence") return mockBuilder({ data: [evidenceRow], error: null });
        if (table === "food_facets") {
          return mockBuilder({ data: [{ food_key: "catalog_revision:42", facet: "contains_gluten",
            p: 0.07 }], error: null });
        }
        if (table === "catalog_food_revisions") {
          return mockBuilder({ data: [{ id: 42, description: "Crunchy bites", brand: null,
            catalog_ingredients: [{ seq: 1, name: "Wheat flour", raw_text: "bleached flour",
              allergen_tags: null }] }], error: null });
        }
        return mockBuilder({ data: [], error: null });
      },
    };
    expect(await loadContradictions(admin as never)).toEqual([]);
  });
});

// DeepSeek audit round 4 (MINOR): a user food's UUID is a stable identifier too — redact it from
// anything printed, the same as its name, even though the real Contradiction.foodKey is unchanged.
describe("redactedFoodKey", () => {
  it("redacts the uuid portion of a user food's key, leaving a catalog key alone", () => {
    expect(redactedFoodKey(`user_food:${USER_FOOD_ID}:1`)).toBe("user_food:<redacted>");
    expect(redactedFoodKey("catalog_revision:1893")).toBe("catalog_revision:1893");
  });
});

describe("userFoodInfoKey", () => {
  it("drops the revision so a stale evidence-row key still matches the food's current row", () => {
    expect(userFoodInfoKey(`user_food:${USER_FOOD_ID}:1`)).toBe(`user_food:${USER_FOOD_ID}`);
    expect(userFoodInfoKey(`user_food:${USER_FOOD_ID}:7`)).toBe(`user_food:${USER_FOOD_ID}`);
  });

  it("returns null for a catalog key (unchanged lookup)", () => {
    expect(userFoodInfoKey("catalog_revision:1893")).toBeNull();
  });
});

describe("findContradictions (pure)", () => {
  const info: FoodInfo = { foodName: "Rice, white, long-grain, regular, cooked, unenriched, with salt",
    foodBrand: null, ingredientsText: null };

  it("flags a jev-sourced listed row whose every relevant facet scored below the floor", () => {
    const out = findContradictions([row({})], () => 0.07, () => info);
    expect(out).toEqual([{ foodKey: "catalog_revision:1", allergen: "gluten", maxP: 0.07,
      foodName: info.foodName, userId: null, updatedAt: UPDATED_AT }]);
  });

  it("carries the row's own user_id and updated_at through, for the repair's delete to re-assert", () => {
    const out = findContradictions(
      [row({ food_key: `user_food:${USER_FOOD_ID}:1`, user_id: USER_FOOD_ID, updated_at: UPDATED_AT })],
      () => 0.07, () => ({ foodName: null, ingredientsText: null }));
    expect(out).toEqual([{ foodKey: `user_food:${USER_FOOD_ID}:1`, allergen: "gluten", maxP: 0.07,
      foodName: null, userId: USER_FOOD_ID, updatedAt: UPDATED_AT }]);
  });

  it("leaves a confident facet alone", () => {
    expect(findContradictions([row({})], () => 0.96, () => info)).toEqual([]);
  });

  it("leaves anything not jev-sourced alone (a real label or tag, never touched)", () => {
    expect(findContradictions([row({ source: "ingredients" })], () => 0.07, () => info)).toEqual([]);
    expect(findContradictions([row({ source: "label" })], () => 0.07, () => info)).toEqual([]);
    expect(findContradictions([row({ source: "legacy" })], () => 0.07, () => info)).toEqual([]);
  });

  it("leaves a not_listed or no_evidence row alone — only a stored listed is a candidate", () => {
    expect(findContradictions([row({ level: "not_listed" })], () => 0.07, () => info)).toEqual([]);
    expect(findContradictions([row({ level: "no_evidence" })], () => 0.07, () => info)).toEqual([]);
  });

  it("skips when no facet reading is on file at all — never assume low from silence", () => {
    expect(findContradictions([row({})], () => null, () => info)).toEqual([]);
  });

  /**
   * Grok audit (2026-10-03, MAJOR): an unresolved food (lookup miss, a deleted row, a read that
   * never reached this key) used to skip the text/name veto entirely and still qualify for
   * deletion — the exact opposite of "cannot verify" leaving the row alone.
   */
  it("never repairs a row it cannot look up current food info for — unknown fails closed", () => {
    expect(findContradictions([row({})], () => 0.07, () => undefined)).toEqual([]);
  });

  it("never deletes real evidence: current ingredient text or name naming the allergen wins", () => {
    const withText: FoodInfo = { foodName: "Rice", ingredientsText: "Wheat flour, rice" };
    expect(findContradictions([row({})], () => 0.07, () => withText)).toEqual([]);
    const namedInTitle: FoodInfo = { foodName: "Wheat and rice pilaf", ingredientsText: null };
    expect(findContradictions([row({})], () => 0.07, () => namedInTitle)).toEqual([]);
  });

  /**
   * Grok audit round 2 (MAJOR): `deriveEvidence` treats a matching structured allergen tag as
   * `listed` on its own (lib/policy/allergens.ts `tagged`) — the repair's own veto must honor the
   * same signal, not just free text.
   */
  it("never deletes real evidence: a structured allergen tag wins, same as text", () => {
    const tagged: FoodInfo = { foodName: "Mystery mix", ingredientsText: null, tags: ["gluten"] };
    expect(findContradictions([row({})], () => 0.07, () => tagged)).toEqual([]);
  });

  /**
   * Grok audit round 3 (BLOCKER): an exact `allergenKey(tag) === key` match missed a tag spelled
   * as a family member of the rule's own key (e.g. "wheat", not "gluten") — the veto now runs
   * the same keyword scan free text already gets.
   */
  it("never deletes real evidence: a family-member tag (wheat, not gluten) wins too", () => {
    const wheatTagged: FoodInfo = { foodName: "Mystery mix", ingredientsText: null, tags: ["wheat"] };
    expect(findContradictions([row({})], () => 0.07, () => wheatTagged)).toEqual([]);
  });

  // Grok audit round 3 (MINOR): the brand is loaded and must be checked, same as the name.
  it("never deletes real evidence: the brand naming the allergen wins too", () => {
    const branded: FoodInfo = { foodName: "Crunchy bites", foodBrand: "Big Wheat Co",
      ingredientsText: null };
    expect(findContradictions([row({})], () => 0.07, () => branded)).toEqual([]);
  });

  it("skips an allergen with no Jev facet (nothing Jev could have written)", () => {
    expect(findContradictions([row({ allergen: "wheat" })], () => 0.07, () => info)).toEqual([]);
  });

  describe("a user food's real name protects it, but is never the output name (DeepSeek round 2, BLOCKER)", () => {
    const userFoodKey = `user_food:${USER_FOOD_ID}:1`;

    it("a low-confidence facet alone still qualifies a user food with no name/text signal", () => {
      const userInfo: FoodInfo = { foodName: null, ingredientsText: null };
      expect(findContradictions([row({ food_key: userFoodKey })], () => 0.96, () => userInfo)).toEqual([]);
      const out = findContradictions([row({ food_key: userFoodKey })], () => 0.07, () => userInfo);
      expect(out).toEqual([{ foodKey: userFoodKey, allergen: "gluten", maxP: 0.07, foodName: null,
        userId: null, updatedAt: UPDATED_AT }]);
    });

    it("a user food genuinely NAMED for the allergen is protected by that name, read internally", () => {
      // The user wrote "Wheat crackers" themselves; with no ingredients_text on file, the name is
      // the only signal left once the low Jev score is discounted — it must still win.
      const named: FoodInfo = { foodName: "Wheat crackers", ingredientsText: null };
      expect(findContradictions([row({ food_key: userFoodKey })], () => 0.07, () => named)).toEqual([]);
    });

    it("even when protected by name, the output Contradiction never carries a user food's name", () => {
      // Flip the case so it DOES qualify for repair, and confirm the kept name never leaks even
      // when `foodInfo` happens to return one (it always does for a resolved user food).
      const named: FoodInfo = { foodName: "Some other food", ingredientsText: null };
      const out = findContradictions([row({ food_key: userFoodKey })], () => 0.07, () => named);
      expect(out).toEqual([{ foodKey: userFoodKey, allergen: "gluten", maxP: 0.07, foodName: null,
        userId: null, updatedAt: UPDATED_AT }]);
    });
  });
});

/**
 * Coordinator security review (2026-10-03): prove — not just assert — that a row this repair
 * deletes can never read back as a CLEARED allergen. The worst case is a user-authored food whose
 * only "evidence" was the deleted row: no current ingredient text, a name with no recognizable
 * whole-food class. After deletion the food has no stored evidence at all — `allergenFinding`'s
 * live read is this repo's ONLY way to decide an outcome from that state, and it is exercised
 * directly here (not re-implemented): it must stay "unknown" (checkable — "Check the label"),
 * never "absent".
 */
describe("post-repair state is never a false clearance (fail-closed, coordinator audit)", () => {
  it("a deleted row's food, with no current text and no recognizable whole-food class, " +
    "stays unverified — never 'absent'", () => {
    const finding = allergenFinding("gluten", { foodName: "Grandma's secret mix", ingredientsText: null });
    expect(finding.outcome).toBe("unknown");
    expect(finding.checkable).toBe(true);
  });

  it("a deleted row never un-blocks a food that still genuinely names the allergen", () => {
    // If the deleted row's food ALSO names the allergen in its current text or name, the live
    // read escalates independently of anything the repair script ever stored or removed.
    const finding = allergenFinding("gluten", { foodName: "Wheat pasta", ingredientsText: null });
    expect(finding.outcome).toBe("present");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", BRANCH_URL);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("allergen evidence repair --fix production guard", () => {
  it("derives the project ref from the hostname only", () => {
    expect(projectRef(PRODUCTION_URL)).toBe("fivatgdpuenszxxnijpc");
    expect(projectRef("https://example.com/?ref=fivatgdpuenszxxnijpc")).toBeNull();
    expect(projectRef("not a url")).toBeNull();
    expect(projectRef(undefined)).toBeNull();
    expect(projectRef("http://127.0.0.1:54321")).toBe("local");
  });

  // Grok audit round 2 (MINOR, verified and declined — see audit-dispositions.md): Node's WHATWG
  // URL keeps the brackets in `hostname` for an IPv6 literal, so this DOES match the loopback it
  // claims to.
  it("recognizes a bracketed IPv6 loopback the same way a plain one is", () => {
    expect(projectRef("http://[::1]:54321")).toBe("local");
  });

  it("refuses --fix on production without --production, before any client is created", async () => {
    vi.stubEnv("SUPABASE_URL", PRODUCTION_URL);
    await expect(main(["--fix"])).rejects.toThrow(/refuses production project .* without --production/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("allows --fix --production on production as the deliberate repair", () => {
    expect(() => assertWriteTarget(["--fix", "--production"], PRODUCTION_URL)).not.toThrow();
  });

  it("refuses --production anywhere but production, and without --fix", () => {
    expect(() => assertWriteTarget(["--fix", "--production"], BRANCH_URL)).toThrow(/is not production/);
    expect(() => assertWriteTarget(["--production"], PRODUCTION_URL)).toThrow(/only applies together with --fix/);
  });

  it("refuses --fix when the project cannot be identified", () => {
    expect(() => assertWriteTarget(["--fix"], undefined)).toThrow(/cannot identify/);
    expect(() => assertWriteTarget(["--fix"], "https://example.com")).toThrow(/cannot identify/);
  });

  it("keeps the read-only report and branch --fix unguarded, and --branch-check off production", () => {
    expect(() => assertWriteTarget([], PRODUCTION_URL)).not.toThrow();
    expect(() => assertWriteTarget(["--fix"], BRANCH_URL)).not.toThrow();
    expect(() => assertWriteTarget(["--fix"], "http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertWriteTarget(["--branch-check"], PRODUCTION_URL)).toThrow(/--branch-check refuses production/);
  });

  // DeepSeek audit (2026-10-03, MINOR): the branch-check guard reads the project ref exactly the
  // way `assertWriteTarget` does, not a raw substring match that could over- or under-refuse.
  it("--branch-check's own refusal matches the hostname, not a substring of the URL", () => {
    expect(() => assertWriteTarget(["--branch-check"], "https://example.com/?x=fivatgdpuenszxxnijpc"))
      .not.toThrow();
  });

  it("refuses an unknown argument", async () => {
    await expect(main(["--bogus"])).rejects.toThrow(/unknown argument/);
  });
});

/**
 * Phase 18 W2a (review r1 BLOCK 3): a Jev row is a hold now, and a deleted hold reads as
 * no_evidence, which the whole-food class can clear. The delete path is gone from the module
 * itself, not only refused by the CLI, and the CLI refuses --fix and --branch-check.
 */
describe("the repair's delete path is retired", () => {
  it("exports no delete function", async () => {
    const mod = await import("@/scripts/allergen-evidence-repair") as Record<string, unknown>;
    expect(mod.repairContradictions).toBeUndefined();
  });

  it("refuses --fix and --branch-check before any client is created", async () => {
    mocks.adminClient.mockClear();
    await expect(main(["--fix"])).rejects.toThrow(/retired by Phase 18 W2a/);
    await expect(main(["--branch-check"])).rejects.toThrow(/retired by Phase 18 W2a/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});

/**
 * Grok + DeepSeek round 4 (MAJOR, both independently): round 3's `unexplainedContradictions`
 * forgave a skip whenever the remaining row's `updatedAt` had moved — but a re-warm stamps a
 * fresh `updated_at` on every write, including one that re-confirms the SAME bad `listed`/`jev`
 * conclusion. That let `main` exit 0 with the false allergen still stored. `main` now has no
 * such function: it fails whenever `loadContradictions`' own fresh re-scan still returns
 * anything, full stop — the same posture `scripts/food-membership-audit.ts` already takes, and
 * the only signal that can actually tell "fixed" from "still broken".
 */
describe("finiteProbability (pure)", () => {
  it("passes through a real probability", () => {
    expect(finiteProbability(0)).toBe(0);
    expect(finiteProbability(0.07)).toBe(0.07);
    expect(finiteProbability(1)).toBe(1);
  });

  /**
   * Grok audit round 3 (BLOCKER), round 4 ("lock that input with a test"): `Number(null)` is
   * `0`, a confident "definitely absent" — the exact opposite of "cannot verify".
   */
  it("treats null, undefined and NaN as unknown, never as a confident zero", () => {
    expect(finiteProbability(null)).toBeNull();
    expect(finiteProbability(undefined)).toBeNull();
    expect(finiteProbability(Number.NaN)).toBeNull();
    expect(finiteProbability("not a number")).toBeNull();
  });
});
