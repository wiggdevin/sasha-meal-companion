/**
 * W13 acceptance 3: the star-to-Favored script converges on a branch (a second run makes 0
 * changes) and never overrides Avoid. Exercises the pure plan/commit functions over the in-memory
 * PostgREST double (tests/helpers/occasion-fake-db.ts), with a `set_food_membership` RPC double
 * that mutates `food_membership_revisions` the same way the real migration's function does, so
 * `readMembershipRevisions` (the same reader lib/server/taste-favor.ts uses) sees the write back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { familyRefs } from "@/tests/helpers/favor-fakes";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => state.client }));

const { assertWriteTarget, commitStarMerge, planStarMerge, summarize } =
  await import("@/scripts/star-to-favored");

const USER = "11111111-1111-4111-8111-111111111111";

function rpc(tables: Record<string, Row[]>) {
  return (name: string, args: Record<string, unknown>) => {
    if (name === "favor_family_sets") {
      const families = args.p_families as string[];
      return families.map((family) => ({ name: family, ref_ids: familyRefs(tables, args.p_user as string, family) }));
    }
    if (name !== "set_food_membership") throw new Error(`unexpected rpc ${name}`);
    const rows = (tables.food_membership_revisions ??= []);
    const existing = rows.find((r) => r.user_id === args.p_user && r.name_norm === args.p_name_norm);
    if (existing) Object.assign(existing, { status: args.p_status, rev: args.p_rev });
    else rows.push({ user_id: args.p_user, name_norm: args.p_name_norm, status: args.p_status, rev: args.p_rev });
    return { rev: args.p_rev, status: args.p_status, updated: 1, truncated: false, notes_kept: 0 };
  };
}

function loadFixture() {
  const foods = [
    { id: "f-favor", user_id: USER, name: "Oat milk" },
    { id: "f-eats", user_id: USER, name: "Salmon" },
    { id: "f-avoid", user_id: USER, name: "Peanut butter" },
    // Sol review BLOCK: a legacy-backfilled Avoid with NO food_membership_revisions row at all —
    // backfill_legacy() (20260911000700) writes user_food_prefs directly and never touches that
    // table, so a plan that only reads food_membership_revisions would see this as unmarked.
    { id: "f-legacy-avoid", user_id: USER, name: "Shrimp" },
  ];
  const refs = foods.map((f) => ({ id: `ref-${f.id}`, kind: "user", catalog_food_id: null, user_food_id: f.id }));
  const stars = refs.map((r, i) => ({ user_id: USER, food_ref_id: r.id, deleted_at: null, sort: i }));
  const tables: Record<string, Row[]> = {
    favorites_foods: stars,
    food_refs: refs,
    user_foods: foods,
    catalog_food_revisions: [],
    food_membership_revisions: [
      { user_id: USER, name_norm: "salmon", status: "eats", rev: 1 },
      { user_id: USER, name_norm: "peanut butter", status: "avoid", rev: 1 },
    ],
    user_food_prefs: [
      { user_id: USER, food_ref_id: "ref-f-legacy-avoid", status: "avoid", updated_at: "2026-01-01" },
    ],
  };
  const fake = fakeDb(tables, rpc(tables));
  state.client = fake.client;
  return tables;
}

beforeEach(() => { state.client = null; });

describe("assertWriteTarget", () => {
  it("allows a plain --commit on a branch (not production)", () => {
    expect(() => assertWriteTarget(["--commit"], "https://abcdefghij0123456789.supabase.co")).not.toThrow();
  });
  it("refuses --commit on production without --production", () => {
    expect(() => assertWriteTarget(["--commit"], "https://fivatgdpuenszxxnijpc.supabase.co"))
      .toThrow(/refuses production/);
  });
  it("refuses --production without --commit", () => {
    expect(() => assertWriteTarget(["--production"], "https://fivatgdpuenszxxnijpc.supabase.co"))
      .toThrow(/only applies together with --commit/);
  });
  it("refuses --branch-check against production", () => {
    expect(() => assertWriteTarget(["--branch-check"], "https://fivatgdpuenszxxnijpc.supabase.co"))
      .toThrow(/--branch-check refuses production/);
  });
});

describe("planStarMerge / commitStarMerge", () => {
  it("plans exactly one family per outcome: favor, already-favored, Avoid (incl. legacy)", async () => {
    const tables = loadFixture();
    const entries = await planStarMerge(state.client as never);
    const report = summarize(entries, tables.favorites_foods.length);
    expect(report).toEqual({ starredRows: 4, pairs: 4, toFavor: 1, alreadyFavored: 1, skippedAvoid: 2 });
  });

  it("writes Favored only for the neutral family, and NEVER overrides Avoid (acceptance 3)", async () => {
    const tables = loadFixture();
    const entries = await planStarMerge(state.client as never);
    const written = await commitStarMerge(state.client as never, entries);
    expect(written).toBe(1);
    const marks = tables.food_membership_revisions;
    expect(marks.find((m) => m.name_norm === "oat milk")?.status).toBe("eats");
    expect(marks.find((m) => m.name_norm === "peanut butter")?.status).toBe("avoid");
    expect(marks.find((m) => m.name_norm === "salmon")?.status).toBe("eats");
    // The legacy Avoid never got a food_membership_revisions row written over it.
    expect(marks.find((m) => m.name_norm === "shrimp")).toBeUndefined();
  });

  it("never overrides a legacy-backfilled Avoid that has no food_membership_revisions row at all (Sol review BLOCK)", async () => {
    const tables = loadFixture();
    const entries = await planStarMerge(state.client as never);
    const shrimp = entries.find((e) => e.family === "shrimp");
    expect(shrimp?.status).toBe("avoid");
    await commitStarMerge(state.client as never, entries);
    expect(tables.user_food_prefs.find((p) => p.food_ref_id === "ref-f-legacy-avoid")?.status).toBe("avoid");
    expect(tables.food_membership_revisions.some((m) => m.name_norm === "shrimp")).toBe(false);
  });

  it("a second run converges: 0 further writes (acceptance 3)", async () => {
    loadFixture();
    const first = await commitStarMerge(state.client as never, await planStarMerge(state.client as never));
    expect(first).toBe(1);
    const second = await commitStarMerge(state.client as never, await planStarMerge(state.client as never));
    expect(second).toBe(0);
  });

  it("drops a star whose food has no readable name, rather than guessing", async () => {
    const tables = loadFixture();
    tables.food_refs.push({ id: "ref-ghost", kind: "user", catalog_food_id: null, user_food_id: "missing" });
    tables.favorites_foods.push({ user_id: USER, food_ref_id: "ref-ghost", deleted_at: null, sort: 9 });
    const entries = await planStarMerge(state.client as never);
    expect(entries).toHaveLength(4); // the ghost star contributes nothing
  });
});
