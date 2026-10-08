// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { persistStarterSelection } from "./starter-client";
import { starterChoices, starterFood } from "./starter";

const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const choices = starterChoices([], rules);
const base = { "chicken-breast-roasted": "eats", "turkey-breast-roasted": "eats",
  "white-rice-cooked": "eats", "brown-rice-cooked": "eats",
  "olive-oil": "eats", "avocado-oil": "eats", "egg-white": "avoid" } as const;

describe("starter membership persistence", () => {
  it("a failed write rejects only after every sibling in its batch has settled (final Sol BLOCK)", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const saved = {} as Record<string, ReturnType<typeof starterFood>>;
    const mark = vi.fn(async (food: ReturnType<typeof starterFood>) => {
      if (food.id === "starter:chicken-breast-roasted") throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const deps = { existing: () => saved, mark,
      save: (food: ReturnType<typeof starterFood>) => { saved[food.id] = food; } };
    await expect(persistStarterSelection(base, choices, deps)).rejects.toThrow("boom");
    // The three siblings in the first batch of four landed before the error surfaced, so a retry
    // sees them as already written and queues only what is still missing.
    expect(Object.keys(saved).sort()).toEqual(["starter:brown-rice-cooked",
      "starter:turkey-breast-roasted", "starter:white-rice-cooked"]);
    mark.mockClear();
    mark.mockImplementation(async () => {});
    expect(await persistStarterSelection(base, choices, deps)).toBe(4);
    expect(mark.mock.calls.map(([food]) => food.id)).not.toContain("starter:turkey-breast-roasted");
    unbindAccount();
  });

  it("writes reviewed eats and avoids through the membership path and is idempotent", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const saved = {} as Record<string, ReturnType<typeof starterFood>>;
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    const deps = { existing: () => saved, mark, save: (food: ReturnType<typeof starterFood>) => { saved[food.id] = food; } };
    expect(await persistStarterSelection(base, choices, deps)).toBe(7);
    expect(mark).toHaveBeenCalledTimes(7);
    expect(saved["starter:egg-white"].status).toBe("avoid");
    expect(await persistStarterSelection(base, choices, deps)).toBe(0);
    unbindAccount();
  });

  it("lets reviewed choices replace an old mark and rejects an unsafe eat", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    const existing = { "starter:chicken-breast-roasted": starterFood("chicken-breast-roasted", "avoid") };
    await persistStarterSelection(base, choices, { existing: () => existing, mark, save: vi.fn() });
    expect(mark.mock.calls.length).toBe(7);
    mark.mockClear();
    await persistStarterSelection({ ...base, "whey-protein-powder": "eats" },
      starterChoices([], { ...rules, avoid_allergens: ["dairy"] }),
      { existing: () => ({}), mark, save: vi.fn() });
    expect(mark.mock.calls.some(([food]) => food.name === "Whey protein powder")).toBe(false);
    unbindAccount();
  });

  it("keeps a food excluded between reread and write out, narrowing the TOCTOU window", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const saved = {} as Record<string, ReturnType<typeof starterFood>>;
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    // A rule saved in the gap between the caller's own reread (which produced `choices`, still
    // clean, and still contains whey protein) and this write — e.g. another device adds a dairy
    // allergy right after "Use this plan" is tapped — must still keep whey protein out, even
    // though `allowed` (`choices`) here has no idea it happened: the pre-write recheck, not the
    // `allowedIds` membership check, has to catch it.
    const freshRules = vi.fn(async () => ({
      profile: { ...rules, avoid_allergens: ["dairy"] }, instances: [],
    }));
    const deps = {
      existing: () => saved, mark, save: (food: ReturnType<typeof starterFood>) => { saved[food.id] = food; },
      freshRules,
    };
    const marksWithWhey = { ...base, "whey-protein-powder": "eats" } as const;
    await persistStarterSelection(marksWithWhey, choices, deps);
    expect(freshRules).toHaveBeenCalledTimes(1);
    expect(mark.mock.calls.some(([food]) => food.name === "Whey protein powder")).toBe(false);
    expect(saved["starter:whey-protein-powder"]).toBeUndefined();
    unbindAccount();
  });

  it("blocks the whole write, not just the excluded item, when a fresh rule drops the selection below the floor", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    // Both proteins in `base` are land-animal meat; a fresh "no beef/poultry" rule (e.g. a
    // just-saved halal/kosher flag) drops the selection to zero proteins — below the two-per-role
    // floor `starterSelectionValid` enforces. That must fail the whole write up front, not write
    // the (now unsafe) carb/fat picks while silently skipping both proteins (Sol r1 WARN).
    const freshRules = vi.fn(async () => ({
      profile: { ...rules, banned_categories: ["poultry", "beef"] }, instances: [],
    }));
    const deps = { existing: () => ({}), mark, save: vi.fn(), freshRules };
    await expect(persistStarterSelection(base, choices, deps)).rejects.toThrow(
      "A rule just changed what's safe to eat — go back to Foods and choose again.");
    expect(mark).not.toHaveBeenCalled();
    unbindAccount();
  });

  it("fails the write closed when the fresh-rules read itself fails, rather than falling back to the stale list", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    const freshRules = vi.fn(async () => null);
    const deps = { existing: () => ({}), mark, save: vi.fn(), freshRules };
    await expect(persistStarterSelection(base, choices, deps)).rejects.toThrow(
      "Couldn’t verify your food rules. Go back to Foods and retry.");
    expect(mark).not.toHaveBeenCalled();
    unbindAccount();
  });

  it("excludes every starter, matching starterChoices, once a food-ref-ID rule is active", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    const freshRules = vi.fn(async () => ({
      profile: { ...rules, avoid_food_ref_ids: ["some-unresolved-ref"] }, instances: [],
    }));
    const deps = { existing: () => ({}), mark, save: vi.fn(), freshRules };
    await expect(persistStarterSelection(base, choices, deps)).rejects.toThrow(
      "A rule just changed what's safe to eat — go back to Foods and choose again.");
    expect(mark).not.toHaveBeenCalled();
    unbindAccount();
  });

  it("writes a reviewed Avoid over a prior Eat but preserves it during auto-seed", async () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const current = { "starter:egg-white": starterFood("egg-white", "eats") };
    const mark = vi.fn(async (_food: ReturnType<typeof starterFood>) => {});
    const deps = { existing: () => current, mark, save: vi.fn() };
    expect(await persistStarterSelection(base, choices, deps, "reviewed")).toBe(7);
    expect(mark.mock.calls.some(([food]) => food.name === current["starter:egg-white"].name
      && food.status === "avoid")).toBe(true);
    mark.mockClear();
    expect(await persistStarterSelection(base, choices, deps, "suggested")).toBe(6);
    expect(mark.mock.calls.some(([food]) => food.name === current["starter:egg-white"].name)).toBe(false);
    unbindAccount();
  });
});
