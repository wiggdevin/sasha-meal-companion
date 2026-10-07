/**
 * scripts/annotate-universe.ts (Phase 18 W1): the write guard is food-membership-audit's, with
 * `--commit` in the place of `--fix`, and a refused run opens no connection; the plan identifies
 * each item by its one active SR Legacy revision, writes only what differs, and keeps Jev holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { EVIDENCE_KEYS, evidenceFromInputs } from "@/lib/policy/allergens";
import type { EvidenceByFood } from "@/lib/server/allergen-evidence";

const mocks = vi.hoisted(() => ({ adminClient: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => mocks.adminClient() }));

const { assertCommitTarget, main, planAnnotations } = await import("@/scripts/annotate-universe");

const PRODUCTION_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
const BRANCH_URL = "https://abcdefghijklmnopqrst.supabase.co";

const item = (id: string) => deriveItem(universeEntry(id)!) as UniverseItem;
const revision = (it: UniverseItem, over: Record<string, unknown> = {}) => ({
  id: 9000 + it.entry.fdcId % 1000, source_id: String(it.entry.fdcId), description: it.row.sr,
  category: it.row.srCategory ?? null, policy_categories: it.policyCategories, is_active: true, ...over,
});
const storedFor = (it: UniverseItem, id: number): EvidenceByFood =>
  new Map([[`catalog_revision:${id}`, evidenceFromInputs({ ingredientsText: null, labelComplete: false,
    foodName: it.row.sr })]]);

describe("annotate-universe write guard", () => {
  beforeEach(() => mocks.adminClient.mockReset());

  it("reads any project, writes a branch, and needs --production for production", () => {
    expect(() => assertCommitTarget([], PRODUCTION_URL)).not.toThrow();
    expect(() => assertCommitTarget(["--commit"], BRANCH_URL)).not.toThrow();
    expect(() => assertCommitTarget(["--commit"], PRODUCTION_URL)).toThrow(/--commit refuses production/);
    expect(() => assertCommitTarget(["--commit", "--production"], PRODUCTION_URL)).not.toThrow();
    expect(() => assertCommitTarget(["--production"], PRODUCTION_URL)).toThrow(/only applies together with --commit/);
    expect(() => assertCommitTarget(["--commit", "--production"], BRANCH_URL)).toThrow(/is not production/);
    expect(() => assertCommitTarget(["--commit"], "not a url")).toThrow(/cannot identify/);
  });

  it("opens no connection when the guard refuses, or for an unknown flag", async () => {
    vi.stubEnv("SUPABASE_URL", PRODUCTION_URL);
    await expect(main(["--commit"])).rejects.toThrow(/refuses production/);
    await expect(main(["--fix"])).rejects.toThrow(/unknown argument/);
    expect(mocks.adminClient).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("planAnnotations", () => {
  const chicken = item("chicken-breast-roasted");
  const tofu = item("tofu-firm");

  it("reports an item with no, or more than one, active revision and never writes it", () => {
    const plan = planAnnotations([chicken, tofu], [revision(tofu), revision(tofu, { id: 2 })], new Map());
    expect(plan.problems).toHaveLength(2);
    expect(plan.evidenceFoods).toEqual([]);
    expect(plan.categoryWrites).toEqual([]);
  });

  it("reports a revision whose description or food group drifted from the bundled row", () => {
    const plan = planAnnotations([chicken], [revision(chicken, { description: "Chicken, other" })], new Map());
    expect(plan.problems[0]).toMatch(/chicken-breast-roasted: revision/);
    expect(plan.evidenceFoods).toEqual([]);
  });

  it("writes NULL policy_categories and missing evidence, and nothing on an annotated re-run", () => {
    const row = revision(chicken, { policy_categories: null });
    const first = planAnnotations([chicken], [row], new Map());
    expect(first.categoryWrites).toEqual([{ revisionId: row.id, itemId: chicken.entry.id, keys: [] }]);
    expect(first.evidenceChanges).toHaveLength(EVIDENCE_KEYS.length);
    expect(first.evidenceFoods[0]).toMatchObject({ foodKey: `catalog_revision:${row.id}`, foodName: chicken.row.sr,
      ingredientsText: null, labelComplete: false, userId: null });
    const again = planAnnotations([chicken], [revision(chicken, { policy_categories: [] })], storedFor(chicken, row.id));
    expect(again.categoryWrites).toEqual([]);
    expect(again.evidenceChanges).toEqual([]);
  });

  it("keeps a stored Jev hold as it is (W2a)", () => {
    const row = revision(tofu);
    const stored = storedFor(tofu, row.id);
    const current = stored.get(`catalog_revision:${row.id}`)!;
    current.dairy = { level: "listed", labelComplete: false, held: true };
    expect(planAnnotations([tofu], [row], stored).evidenceChanges).toEqual([]);
  });
});
