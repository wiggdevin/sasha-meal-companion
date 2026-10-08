/**
 * W13 acceptance 3: the star-to-Favored script converges on a branch (a second run makes 0
 * changes) and never overrides Avoid. Exercises the pure plan/commit functions over the in-memory
 * PostgREST double (tests/helpers/occasion-fake-db.ts), with a `set_food_membership` RPC double
 * that mutates `food_membership_revisions` the same way the real migration's function does, so
 * the script's own membership read sees the write back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type QueryLog, type Row } from "@/tests/helpers/occasion-fake-db";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => state.client }));

const { assertWriteTarget, commitStarMerge, planStarMerge, summarize } =
  await import("@/scripts/star-to-favored");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function rpc(tables: Record<string, Row[]>) {
  return (name: string, args: Record<string, unknown>) => {
    if (name !== "set_food_membership") throw new Error(`unexpected rpc ${name}`);
    const rows = (tables.food_membership_revisions ??= []);
    const existing = rows.find((r) => r.user_id === args.p_user && r.name_norm === args.p_name_norm);
    if (existing) Object.assign(existing, { status: args.p_status, rev: args.p_rev });
    else rows.push({ user_id: args.p_user, name_norm: args.p_name_norm, status: args.p_status, rev: args.p_rev });
    return { rev: args.p_rev, status: args.p_status, updated: 1, truncated: false, notes_kept: 0 };
  };
}

let queries: QueryLog[] = [];

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
  queries = fake.queries;
  return tables;
}

beforeEach(() => { state.client = null; queries = []; });

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
    const plan = await planStarMerge(state.client as never);
    expect(summarize(plan, tables.favorites_foods.length)).toEqual({ starredRows: 4, pairs: 4, toFavor: 1,
      alreadyFavored: 1, skippedAvoid: 2, skippedForeign: 0, skippedUnreadable: 0 });
  });

  it("writes Favored only for the neutral family, and NEVER overrides Avoid (acceptance 3)", async () => {
    const tables = loadFixture();
    const written = await commitStarMerge(state.client as never, await planStarMerge(state.client as never));
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
    const plan = await planStarMerge(state.client as never);
    expect(plan.entries.find((e) => e.family === "shrimp")?.status).toBe("avoid");
    await commitStarMerge(state.client as never, plan);
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
    const plan = await planStarMerge(state.client as never);
    expect(plan.entries).toHaveLength(4); // the ghost star contributes nothing
    expect(plan.skippedUnreadable).toBe(1);
  });

  it("never overrides an Avoid on a family member outside the 50-ref write set (Sol round 2 BLOCK)", async () => {
    const tables = loadFixture();
    // 51 catalog rows named "Tuna, ...": set_food_membership / favor_family_sets stop at 50 refs,
    // and the Avoid sits on the 51st, the row a capped check never sees.
    for (let i = 0; i < 51; i += 1) {
      tables.catalog_food_revisions.push({ catalog_food_id: 1000 + i, description: `Tuna, cut ${i}`, is_active: true });
      tables.food_refs.push({ id: `ref-tuna-${String(i).padStart(2, "0")}`, kind: "catalog",
        catalog_food_id: 1000 + i, user_food_id: null });
    }
    tables.favorites_foods.push({ user_id: USER, food_ref_id: "ref-tuna-00", deleted_at: null, sort: 10 });
    tables.user_food_prefs.push({ user_id: USER, food_ref_id: "ref-tuna-50", status: "avoid", updated_at: "2020-01-01" });
    const plan = await planStarMerge(state.client as never);
    expect(plan.entries.find((e) => e.family === "tuna")?.status).toBe("avoid");
    await commitStarMerge(state.client as never, plan);
    expect(tables.food_membership_revisions.some((m) => m.name_norm === "tuna")).toBe(false);
  });

  it("never overrides an Avoid kept on a SOFT-DELETED same-family user food, as _favor_family_avoided "
    + "does (Sol round 3 BLOCK)", async () => {
    const tables = loadFixture();
    tables.user_foods.push({ id: "f-tuna-gone", user_id: USER, name: "Tuna", deleted_at: "2026-09-01T00:00:00Z" });
    tables.food_refs.push({ id: "ref-f-tuna-gone", kind: "user", catalog_food_id: null, user_food_id: "f-tuna-gone" });
    tables.user_food_prefs.push({ user_id: USER, food_ref_id: "ref-f-tuna-gone", status: "avoid", updated_at: "2026-08-01" });
    tables.catalog_food_revisions.push({ catalog_food_id: 777, description: "Tuna", is_active: true });
    tables.food_refs.push({ id: "ref-cat-tuna", kind: "catalog", catalog_food_id: 777, user_food_id: null });
    tables.favorites_foods.push({ user_id: USER, food_ref_id: "ref-cat-tuna", deleted_at: null, sort: 12 });
    const plan = await planStarMerge(state.client as never);
    expect(plan.entries.find((e) => e.family === "tuna")?.status).toBe("avoid");
    await commitStarMerge(state.client as never, plan);
    expect(tables.food_membership_revisions.some((m) => m.name_norm === "tuna")).toBe(false);
    // The deleted-food read is still owner-scoped.
    expect(queries.filter((q) => q.table === "user_foods" && !q.filters.includes("is:deleted_at"))
      .every((q) => q.filters.includes("eq:user_id") || q.filters.length === 1)).toBe(true);
  });

  it("a star on a soft-deleted food is still never named (only the Avoid side reads deleted rows)", async () => {
    const tables = loadFixture();
    tables.user_foods.push({ id: "f-gone", user_id: USER, name: "Kale", deleted_at: "2026-09-01T00:00:00Z" });
    tables.food_refs.push({ id: "ref-f-gone", kind: "user", catalog_food_id: null, user_food_id: "f-gone" });
    tables.favorites_foods.push({ user_id: USER, food_ref_id: "ref-f-gone", deleted_at: null, sort: 13 });
    const plan = await planStarMerge(state.client as never);
    expect(plan.entries.some((e) => e.family === "kale")).toBe(false);
    expect(plan.skippedUnreadable).toBe(1);
  });

  it("skips a star on ANOTHER account's user food: never named, never written (Sol round 2 BLOCK)", async () => {
    const tables = loadFixture();
    tables.user_foods.push({ id: "f-foreign", user_id: OTHER, name: "Grandma stew" });
    tables.food_refs.push({ id: "ref-foreign", kind: "user", catalog_food_id: null, user_food_id: "f-foreign" });
    tables.favorites_foods.push({ user_id: USER, food_ref_id: "ref-foreign", deleted_at: null, sort: 11 });
    const plan = await planStarMerge(state.client as never);
    expect(plan.skippedForeign).toBe(1);
    expect(plan.entries.some((e) => e.family.includes("stew"))).toBe(false);
    await commitStarMerge(state.client as never, plan);
    expect(tables.food_membership_revisions.some((m) => String(m.name_norm).includes("stew"))).toBe(false);
    expect(summarize(plan, tables.favorites_foods.length).skippedForeign).toBe(1);
  });

  it("reads every account-owned table with the owner's explicit user_id", async () => {
    loadFixture();
    await planStarMerge(state.client as never);
    for (const table of ["food_membership_revisions", "user_food_prefs"]) {
      const reads = queries.filter((q) => q.table === table);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((q) => q.filters.includes("eq:user_id"))).toBe(true);
    }
    // user_foods: every read that can return a name is owner-scoped; the only other read is the
    // id-only foreign check (it has no deleted_at filter and selects id,user_id).
    const named = queries.filter((q) => q.table === "user_foods" && q.filters.includes("is:deleted_at"));
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((q) => q.filters.includes("eq:user_id"))).toBe(true);
  });
});
