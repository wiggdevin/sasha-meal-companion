/**
 * Phase 18 W5b acceptance 5 (docs/specs/phase-18-open-world-foods.md D6, D9): a confirmed taste
 * dislike lowers rank only; the food stays admitted.
 *
 * Ranking does not read `diet_prefs.taste` yet (that is `pref-2`, W7, and the snapshot, W8), so this
 * pins the property at the layers that exist today:
 *   - admission (lib/server/candidate-foods.ts, the D4 order every generating surface will read):
 *     an account that dislikes every universe family and every sensory tag admits exactly the same
 *     foods, in a closed and an open world, as one with no dislikes;
 *   - ranking (`rankAdmitted`, step 4): a dislike penalty reorders the admitted ids and never drops
 *     one.
 * When W7 wires the dislike into the score, its own tests extend the second half.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { rankAdmitted } from "@/lib/foods/world/admission";
import { SENSORY_TAGS } from "@/lib/profile/taste";
import { fakeDb } from "@/tests/helpers/occasion-fake-db";
import { A, eatsEvidence, worldTables } from "@/tests/helpers/world-fixtures";

const evidence = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: async () => evidence.answer,
}));

const { candidateFoods } = await import("@/lib/server/candidate-foods");

beforeEach(() => { evidence.answer = eatsEvidence(); });

const FAMILIES = [...new Set(UNIVERSE.map((entry) => baseFoodName(dbFood(entry.id)?.name ?? "")))]
  .filter((family) => family.length > 0);
/** The stored cap is 50, but admission must ignore taste at any size: dislike everything. */
const EVERYTHING = { dislikes: [...FAMILIES.map((f) => `f:${f}`), ...SENSORY_TAGS.map((t) => `t:${t}`)] };

async function admitted(world: "open" | "closed", taste?: object) {
  const tables = worldTables({ world });
  if (taste) tables.user_settings[0].diet_prefs = { flags: [], taste };
  const result = await candidateFoods(fakeDb(tables).client, A);
  return { refs: result.admittedRefIds, universe: result.admittedUniverseIds, excluded: result.excluded };
}

describe("a taste dislike never excludes (acceptance 5)", () => {
  it("admits exactly the same foods with every family and tag disliked, closed and open", async () => {
    for (const world of ["closed", "open"] as const) {
      const plain = await admitted(world);
      const disliking = await admitted(world, EVERYTHING);
      expect(disliking).toEqual(plain);
    }
    const open = await admitted("open", EVERYTHING);
    expect(open.universe.length).toBeGreaterThan(100);
    expect(open.universe).toContain("chicken-breast-roasted");
  });

  it("a dislike penalty only reorders the admitted ids", () => {
    const ids = ["okra-cooked", "salmon-wild-sockeye-cooked", "white-rice-cooked"];
    const disliked = new Set(["okra-cooked"]);
    const scores = Object.fromEntries(ids.map((id) => [id, 1 - (disliked.has(id) ? 0.5 : 0)]));
    const ranked = rankAdmitted(ids, scores);
    expect(ranked.at(-1)).toBe("okra-cooked");
    expect([...ranked].sort()).toEqual([...ids].sort());
  });
});
