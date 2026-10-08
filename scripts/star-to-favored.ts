/**
 * Phase 18 W13 (D13, D14): the one-time star-to-Favored merge. "The food star (`favorites_foods`)
 * | A bookmark that no generator reads | The Favored toggle on the same row. A one-time script
 * turns each live star into a Favored mark unless the family is on Avoid. The table stays for
 * history."
 *
 * A star is a `favorites_foods` row (`food_ref_id`, live when `deleted_at is null`) — the legacy
 * client's bookmark, read by nothing that generates a plan. "Favored" is `user_food_prefs.status
 * = 'eats'` (D13: the wire name stays `eats`; only the copy reads "Favored"), written the same
 * way `set_food_membership` already writes it for `add_to_eats` — by NAME FAMILY
 * (`lib/foods/base-name.ts baseFoodName`), not by one ref, so every same-name row moves together.
 *
 *   (no flag)                        read-only report: starred rows, the distinct (account,
 *                                     family) pairs they resolve to, and how many would be
 *                                     favored, are already Favored, or are skipped because the
 *                                     family is on Avoid. No account id or food name is printed.
 *   --commit                         performs the merge: `set_food_membership(..., 'eats', ...)`
 *                                     for every family that is neither already `eats` nor
 *                                     `avoid`. Never overrides Avoid (acceptance 3) — an avoided
 *                                     family is always skipped, counted, never written. Running
 *                                     it twice makes 0 further writes (idempotent): a family
 *                                     already `eats` is left alone, not re-written at a higher rev.
 *   --commit --production            required together, the owner's deliberate step on production.
 *   --branch-check                   seeds one star in each of the three outcomes (favor, already
 *                                     Favored, on Avoid) for a throwaway user, runs --commit
 *                                     twice, and verifies: first run favors exactly one family and
 *                                     skips the Avoid one; second run favors 0 more. Refuses
 *                                     production.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseFoodName } from "@/lib/foods/base-name";
import { adminClient } from "@/lib/server/admin";
import { readByIdBatches } from "@/lib/server/date-chunks";
import { readFamilySets, readMembershipRevisions } from "@/lib/server/membership-revisions";
import { fetchAllRows } from "@/lib/server/paged-read";
import { projectRef } from "@/scripts/food-membership-audit";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throws when the flags would write somewhere they should not. Pure; reads only its inputs. */
export function assertWriteTarget(argv: readonly string[], url: string | undefined): void {
  const ref = projectRef(url);
  const production = ref === PRODUCTION_REF;
  const commit = argv.includes("--commit");
  const optIn = argv.includes("--production");
  if (argv.includes("--branch-check") && (production || (url ?? "").includes(PRODUCTION_REF))) {
    throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  }
  if (optIn && !commit) throw new Error("--production only applies together with --commit");
  if (optIn && !production) {
    throw new Error(`--production given, but SUPABASE_URL is not production project ${PRODUCTION_REF}`);
  }
  if (!commit) return;
  if (ref === null) throw new Error("--commit refuses: cannot identify the Supabase project from SUPABASE_URL");
  if (production && !optIn) {
    throw new Error(`--commit refuses production project ${PRODUCTION_REF} without --production; `
      + "run --branch-check on a branch first, then repeat with --commit --production as a deliberate step");
  }
}

type StarRow = { user_id: string; food_ref_id: string };
type RefRow = { id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null };

async function selectAll<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(message(error));
  return (data ?? []) as T[];
}

/**
 * Every live star. Sol review BLOCK: a plain `.select()` silently stops at the API's row cap
 * (`max_rows = 1000`, supabase/config.toml) with no sign of truncation — a script meant to run
 * once over every account's stars must never read a partial set and report it as the whole one.
 * Paged by `fetchAllRows` (lib/server/paged-read.ts), ordered on the table's own primary key.
 */
async function allStars(admin: SupabaseClient): Promise<StarRow[]> {
  return fetchAllRows<StarRow>((from, to) => admin.from("favorites_foods")
    .select("user_id,food_ref_id").is("deleted_at", null)
    .order("user_id").order("food_ref_id").range(from, to));
}

/** Each live star's resolved display name, by (user, food_ref_id); a ref with no readable name
 *  (deleted food, broken row) maps to null and is dropped — never guessed at. `.in(...)` lookups
 *  are chunked (`readByIdBatches`) so a large star table never hits the row cap on this side
 *  either — the same pagination risk Sol flagged for the star scan itself. */
async function starNames(admin: SupabaseClient, stars: readonly StarRow[]): Promise<Map<string, string | null>> {
  const refIds = [...new Set(stars.map((s) => s.food_ref_id))];
  if (refIds.length === 0) return new Map();
  const refs = await readByIdBatches(refIds, (batch) => selectAll<RefRow>(admin.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id").in("id", batch)));
  const userFoodIds = refs.flatMap((r) => r.kind === "user" && r.user_food_id ? [r.user_food_id] : []);
  const catalogIds = refs.flatMap((r) => r.kind === "catalog" && r.catalog_food_id !== null
    ? [r.catalog_food_id] : []);
  const [userFoods, catalog] = await Promise.all([
    readByIdBatches(userFoodIds, (batch) => selectAll<{ id: string; name: string }>(admin
      .from("user_foods").select("id,name").in("id", batch))),
    readByIdBatches(catalogIds, (batch) => selectAll<{ catalog_food_id: number; description: string }>(admin
      .from("catalog_food_revisions").select("catalog_food_id,description")
      .in("catalog_food_id", batch).eq("is_active", true))),
  ]);
  const byUserFood = new Map(userFoods.map((f) => [f.id, f.name]));
  const byCatalog = new Map(catalog.map((f) => [Number(f.catalog_food_id), f.description]));
  const nameByRef = new Map<string, string | null>();
  for (const ref of refs) {
    const name = ref.kind === "user" ? (ref.user_food_id ? byUserFood.get(ref.user_food_id) : undefined)
      : ref.kind === "catalog" && ref.catalog_food_id !== null ? byCatalog.get(ref.catalog_food_id) : undefined;
    nameByRef.set(ref.id, name ?? null);
  }
  return new Map(stars.map((s) => [`${s.user_id}:${s.food_ref_id}`, nameByRef.get(s.food_ref_id) ?? null]));
}

export type StarPlanEntry = { userId: string; family: string; status: "eats" | "avoid" | null; rev: number };

/**
 * Whether ANY current ref in `family`'s full write set (`favor_family_sets`, migration
 * 20261215090000 — the exact ref ids `set_food_membership` would touch) carries `status =
 * 'avoid'` on `user_food_prefs` right now. Sol review BLOCK: `food_membership_revisions` alone
 * is not the ground truth — `backfill_legacy()` (supabase/migrations/20260911000700_legacy_
 * backfill.sql) writes `user_food_prefs.status = 'avoid'` directly for a migrated account, with
 * no matching `food_membership_revisions` row at all, so a family only ever marked that way read
 * as `status: null` (unmarked) from the revisions table alone — `commitStarMerge` would then
 * write `eats` over it. This checks the live preference rows for the family's own ref set too.
 */
async function hasLiveAvoidRef(
  admin: SupabaseClient, userId: string, refIds: readonly string[],
): Promise<boolean> {
  if (refIds.length === 0) return false;
  const rows = await readByIdBatches(refIds, (batch) => selectAll<{ status: string }>(admin
    .from("user_food_prefs").select("status").eq("user_id", userId).eq("status", "avoid")
    .in("food_ref_id", batch)));
  return rows.length > 0;
}

/** Every live star, resolved to one (account, family) plan entry each, deduplicated. */
export async function planStarMerge(admin: SupabaseClient): Promise<StarPlanEntry[]> {
  const stars = await allStars(admin);
  const names = await starNames(admin, stars);
  const byUser = new Map<string, Set<string>>();
  for (const star of stars) {
    const name = names.get(`${star.user_id}:${star.food_ref_id}`);
    const family = name ? baseFoodName(name) : null;
    if (!family) continue;
    (byUser.get(star.user_id) ?? byUser.set(star.user_id, new Set()).get(star.user_id)!).add(family);
  }
  const entries: StarPlanEntry[] = [];
  for (const [userId, families] of byUser) {
    const names2 = [...families].sort();
    const [marks, sets] = await Promise.all([
      readMembershipRevisions(userId, names2),
      readFamilySets(userId, names2),
    ]);
    for (const family of names2) {
      const mark = marks.get(family);
      const liveAvoid = mark?.status !== "avoid" && await hasLiveAvoidRef(admin, userId, sets.get(family) ?? []);
      const status: "eats" | "avoid" | null = mark?.status === "avoid" || liveAvoid ? "avoid" : mark?.status ?? null;
      entries.push({ userId, family, status, rev: mark?.rev ?? 0 });
    }
  }
  return entries;
}

export type StarMergeReport = { starredRows: number; pairs: number; toFavor: number;
  alreadyFavored: number; skippedAvoid: number };

export function summarize(entries: readonly StarPlanEntry[], starredRows: number): StarMergeReport {
  return { starredRows, pairs: entries.length,
    toFavor: entries.filter((e) => e.status === null).length,
    alreadyFavored: entries.filter((e) => e.status === "eats").length,
    skippedAvoid: entries.filter((e) => e.status === "avoid").length };
}

/** Writes `eats` for every entry with no current mark. Never touches an `avoid` or already-`eats`
 *  family — the first is "never overrides Avoid" (acceptance 3), the second is what makes a
 *  second run a no-op (also acceptance 3). Returns how many families it wrote. */
export async function commitStarMerge(admin: SupabaseClient, entries: readonly StarPlanEntry[]): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    if (entry.status !== null) continue; // already eats, or avoid: never touched
    const { error } = await admin.rpc("set_food_membership", {
      p_user: entry.userId, p_name_norm: entry.family, p_status: "eats",
      p_note: null, p_rev: entry.rev + 1,
    });
    if (error) throw new Error(`star merge failed for ${entry.userId}/${entry.family}: ${message(error)}`);
    written += 1;
  }
  return written;
}

async function report(admin: SupabaseClient): Promise<StarMergeReport> {
  const [{ count }, entries] = await Promise.all([
    admin.from("favorites_foods").select("user_id", { count: "exact", head: true }).is("deleted_at", null)
      .then((r) => ({ count: r.count ?? 0 })),
    planStarMerge(admin),
  ]);
  return summarize(entries, count);
}

function printReport(label: string, r: StarMergeReport): void {
  console.log(`${label}: ${JSON.stringify(r)}`);
}

async function branchCheck(admin: SupabaseClient): Promise<void> {
  const url = process.env.SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_REF)) throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  if (!url) throw new Error("--branch-check needs SUPABASE_URL pointed at the current branch");
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await admin.auth.admin.createUser({
    email: `star-merge-${suffix}@example.invalid`, password: crypto.randomUUID(), email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "test user missing");
  const userId = created.data.user.id;
  try {
    const settings = await admin.from("user_settings").insert({ user_id: userId,
      first_opened_at: new Date().toISOString() });
    if (settings.error) throw new Error(settings.error.message);
    const names = [`star merge favor ${suffix}`, `star merge eats ${suffix}`, `star merge avoid ${suffix}`];
    const foods = names.map((name) => ({ id: crypto.randomUUID(), user_id: userId, name,
      kind: "custom", per_100g: {}, allergen_tags: [] }));
    const insertedFoods = await admin.from("user_foods").insert(foods);
    if (insertedFoods.error) throw new Error(insertedFoods.error.message);
    const refs = foods.map((food) => ({ id: crypto.randomUUID(), kind: "user", user_food_id: food.id }));
    const insertedRefs = await admin.from("food_refs").insert(refs);
    if (insertedRefs.error) throw new Error(insertedRefs.error.message);
    // Seed the pre-existing marks for the "already eats" and "on Avoid" cases.
    const marked = await admin.rpc("set_food_membership", { p_user: userId,
      p_name_norm: names[1], p_status: "eats", p_note: null, p_rev: 1 });
    if (marked.error) throw new Error(marked.error.message);
    const avoided = await admin.rpc("set_food_membership", { p_user: userId,
      p_name_norm: names[2], p_status: "avoid", p_note: null, p_rev: 1 });
    if (avoided.error) throw new Error(avoided.error.message);
    // Star all three.
    const starred = await admin.from("favorites_foods").insert(refs.map((ref, i) => ({
      user_id: userId, food_ref_id: ref.id, sort: i, deleted_at: null,
    })));
    if (starred.error) throw new Error(starred.error.message);

    const firstPlan = (await planStarMerge(admin)).filter((e) => e.userId === userId);
    if (firstPlan.length !== 3) throw new Error(`expected 3 plan entries, found ${firstPlan.length}`);
    const firstWritten = await commitStarMerge(admin, firstPlan);
    if (firstWritten !== 1) throw new Error(`expected 1 write on the first run, wrote ${firstWritten}`);

    const marksAfter = await readMembershipRevisions(userId, names.map(baseFoodName));
    if (marksAfter.get(baseFoodName(names[0]))?.status !== "eats") {
      throw new Error("the neutral star was not favored");
    }
    if (marksAfter.get(baseFoodName(names[2]))?.status !== "avoid") {
      throw new Error("the star merge overrode an Avoid mark");
    }

    const secondPlan = (await planStarMerge(admin)).filter((e) => e.userId === userId);
    const secondWritten = await commitStarMerge(admin, secondPlan);
    if (secondWritten !== 0) throw new Error(`expected 0 writes on the second run, wrote ${secondWritten}`);

    console.log("star merge --branch-check: 1 favored, 1 already-favored skipped, "
      + "1 avoid skipped, second run converged with 0 writes");
  } finally {
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error) console.warn(`star merge branch-check cleanup failed: ${removed.error.message}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const allowed = new Set(["--commit", "--branch-check", "--production"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  // Before any client exists: a refused run opens no connection at all.
  assertWriteTarget(argv, process.env.SUPABASE_URL);
  const admin = adminClient();
  if (argv.includes("--branch-check")) return branchCheck(admin);
  printReport("before", await report(admin));
  if (!argv.includes("--commit")) return;
  const entries = await planStarMerge(admin);
  const written = await commitStarMerge(admin, entries);
  console.log(`star merge wrote ${written} new Favored mark(s)`);
  printReport("after", await report(admin));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
