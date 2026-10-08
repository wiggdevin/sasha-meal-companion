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
 *                                     family is on Avoid (any member of it, never a capped
 *                                     set), plus stars skipped because they point at another
 *                                     account's food or at nothing readable. No account id or
 *                                     food name is printed. Every read of account rows carries
 *                                     the star owner's explicit user_id (the one exception reads
 *                                     only id + user_id, to count a foreign star).
 *   --commit                         performs the merge: `set_food_membership(..., 'eats', ...)`
 *                                     for every family that is neither already `eats` nor
 *                                     `avoid`. Never overrides Avoid (acceptance 3) — an avoided
 *                                     family is always skipped, counted, never written. Running
 *                                     it twice makes 0 further writes (idempotent): a family
 *                                     already `eats` is left alone, not re-written at a higher rev.
 *   --commit --production            required together, the owner's deliberate step on production.
 *   --branch-check                   seeds one star in each of the three outcomes (favor, already
 *                                     Favored, on Avoid) plus one on another account's food, for
 *                                     two throwaway users, runs --commit
 *                                     twice, and verifies: first run favors exactly one family and
 *                                     skips the Avoid one; second run favors 0 more. Refuses
 *                                     production.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseFoodName } from "@/lib/foods/base-name";
// Sol round 2 BLOCK: nothing here may import a module that loads `server-only`
// (lib/server/membership-revisions.ts does): under plain `tsx` that package's default export
// throws at import, before any flag is read. These three modules are server-side but import-safe
// for a CLI; tests/foods/star-to-favored-cli.test.ts starts the real script to prove it.
import { adminClient } from "@/lib/server/admin";
import { readByIdBatches } from "@/lib/server/date-chunks";
import { fetchAllRows } from "@/lib/server/paged-read";
import { projectRef } from "@/scripts/food-membership-audit";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = (error as { message?: unknown } | null)?.message;
  return typeof text === "string" ? text : String(error);
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

/** A ref's name as `owner` may read it: the owner's own live user food or an active catalog
 *  revision; `"foreign"` for a user food that belongs to another account (never named); null
 *  when nothing readable exists (deleted food, broken row) — never guessed at. */
const FOREIGN: unique symbol = Symbol("foreign");
type RefName = string | typeof FOREIGN | null;

/**
 * Sol round 2 BLOCK: every read is scoped to the star's OWNER. `favorites_foods` accepts any
 * `food_ref_id`, so a star can point at another account's user food; this privileged script
 * must never read that food's name, nor apply its family to the owner's preferences. A user
 * food is read with an explicit `user_id = owner` filter; a user ref the owner's read does not
 * return is checked by id only (no name column) to tell "foreign" from "gone", for the report.
 */
async function refNamesFor(
  admin: SupabaseClient, owner: string, refIds: readonly string[],
): Promise<Map<string, RefName>> {
  const out = new Map<string, RefName>();
  if (refIds.length === 0) return out;
  const refs = await readByIdBatches(refIds, (batch) => selectAll<RefRow>(admin.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id").in("id", batch)));
  const userFoodIds = refs.flatMap((r) => r.kind === "user" && r.user_food_id ? [r.user_food_id] : []);
  const catalogIds = refs.flatMap((r) => r.kind === "catalog" && r.catalog_food_id !== null
    ? [r.catalog_food_id] : []);
  const [ownFoods, catalog] = await Promise.all([
    readByIdBatches(userFoodIds, (batch) => selectAll<{ id: string; name: string }>(admin
      .from("user_foods").select("id,name").eq("user_id", owner).is("deleted_at", null).in("id", batch))),
    readByIdBatches(catalogIds, (batch) => selectAll<{ catalog_food_id: number; description: string }>(admin
      .from("catalog_food_revisions").select("catalog_food_id,description")
      .in("catalog_food_id", batch).eq("is_active", true))),
  ]);
  const byUserFood = new Map(ownFoods.map((f) => [f.id, f.name]));
  const notOwn = userFoodIds.filter((id) => !byUserFood.has(id));
  const otherOwner = new Set((await readByIdBatches(notOwn, (batch) => selectAll<{ id: string; user_id: string }>(
    admin.from("user_foods").select("id,user_id").in("id", batch))))
    .filter((f) => f.user_id !== owner).map((f) => f.id));
  const byCatalog = new Map(catalog.map((f) => [Number(f.catalog_food_id), f.description]));
  for (const ref of refs) {
    if (ref.kind === "user") {
      const id = ref.user_food_id;
      out.set(ref.id, id && otherOwner.has(id) ? FOREIGN : (id ? byUserFood.get(id) : undefined) ?? null);
    } else {
      out.set(ref.id, ref.kind === "catalog" && ref.catalog_food_id !== null
        ? byCatalog.get(Number(ref.catalog_food_id)) ?? null : null);
    }
  }
  return out;
}

/** The owner's own membership marks for `families` (`food_membership_revisions`, explicit
 *  `user_id`). Read here rather than through lib/server/membership-revisions.ts, which loads
 *  `server-only` (see the import note above). */
async function membershipMarks(
  admin: SupabaseClient, owner: string, families: readonly string[],
): Promise<Map<string, { status: "eats" | "avoid" | null; rev: number }>> {
  const rows = await readByIdBatches([...families], (batch) => selectAll<{
    name_norm: string; status: string | null; rev: unknown }>(admin.from("food_membership_revisions")
    .select("name_norm,status,rev").eq("user_id", owner).in("name_norm", batch)));
  const out = new Map<string, { status: "eats" | "avoid" | null; rev: number }>();
  for (const row of rows) {
    const rev = Number(row.rev);
    if (!Number.isSafeInteger(rev) || rev < 0) throw new Error("malformed food membership revision");
    out.set(row.name_norm, { status: row.status === "eats" || row.status === "avoid" ? row.status : null, rev });
  }
  return out;
}

/**
 * Every family this owner has on Avoid through a live preference row, over ALL of the account's
 * Avoid prefs — never a capped write set. Sol round 2 BLOCK: the previous check read only the
 * refs `favor_family_sets` returned, which stops at 50 per family, so an Avoid on a 51st
 * same-family catalog ref was missed and the family was written `eats`. This is the rule
 * `_favor_family_avoided` applies in SQL (migration 20261215090000_favor_food_families.sql):
 * any Avoid pref whose ref's name (owner's user food, or active catalog revision) normalizes to
 * the family. The legacy backfill (20260911000700) writes such prefs with no membership row.
 */
async function avoidedFamilies(admin: SupabaseClient, owner: string): Promise<Set<string>> {
  const prefs = await fetchAllRows<{ food_ref_id: string }>((from, to) => admin.from("user_food_prefs")
    .select("food_ref_id").eq("user_id", owner).eq("status", "avoid")
    .order("food_ref_id").range(from, to));
  const names = await refNamesFor(admin, owner, prefs.map((p) => p.food_ref_id));
  const out = new Set<string>();
  for (const name of names.values()) {
    if (name === null || name === FOREIGN) continue;
    const family = baseFoodName(name);
    if (family) out.add(family);
  }
  return out;
}

export type StarPlanEntry = { userId: string; family: string; status: "eats" | "avoid" | null; rev: number };
export type StarPlan = {
  entries: StarPlanEntry[];
  /** Stars on another account's user food: skipped, never named, never written. */
  skippedForeign: number;
  /** Stars whose food has no readable name (deleted, broken): skipped, never guessed at. */
  skippedUnreadable: number;
};

/** Every live star, resolved to one (account, family) plan entry each, deduplicated. */
export async function planStarMerge(admin: SupabaseClient): Promise<StarPlan> {
  const stars = await allStars(admin);
  const refsByOwner = new Map<string, string[]>();
  for (const star of stars) {
    (refsByOwner.get(star.user_id) ?? refsByOwner.set(star.user_id, []).get(star.user_id)!).push(star.food_ref_id);
  }
  const plan: StarPlan = { entries: [], skippedForeign: 0, skippedUnreadable: 0 };
  for (const [owner, refIds] of [...refsByOwner].sort(([a], [b]) => a.localeCompare(b))) {
    const names = await refNamesFor(admin, owner, refIds);
    const families = new Set<string>();
    for (const refId of refIds) {
      const name = names.get(refId) ?? null;
      if (name === FOREIGN) { plan.skippedForeign += 1; continue; }
      const family = name ? baseFoodName(name) : "";
      if (!family) { plan.skippedUnreadable += 1; continue; }
      families.add(family);
    }
    if (families.size === 0) continue;
    const sorted = [...families].sort();
    const [marks, avoided] = await Promise.all([membershipMarks(admin, owner, sorted), avoidedFamilies(admin, owner)]);
    for (const family of sorted) {
      const mark = marks.get(family);
      const status = mark?.status === "avoid" || avoided.has(family) ? "avoid" : mark?.status ?? null;
      plan.entries.push({ userId: owner, family, status, rev: mark?.rev ?? 0 });
    }
  }
  return plan;
}

export type StarMergeReport = { starredRows: number; pairs: number; toFavor: number;
  alreadyFavored: number; skippedAvoid: number; skippedForeign: number; skippedUnreadable: number };

export function summarize(plan: StarPlan, starredRows: number): StarMergeReport {
  const { entries } = plan;
  return { starredRows, pairs: entries.length,
    toFavor: entries.filter((e) => e.status === null).length,
    alreadyFavored: entries.filter((e) => e.status === "eats").length,
    skippedAvoid: entries.filter((e) => e.status === "avoid").length,
    skippedForeign: plan.skippedForeign, skippedUnreadable: plan.skippedUnreadable };
}

/** Writes `eats` for every entry with no current mark. Never touches an `avoid` or already-`eats`
 *  family — the first is "never overrides Avoid" (acceptance 3), the second is what makes a
 *  second run a no-op (also acceptance 3). Returns how many families it wrote. */
export async function commitStarMerge(admin: SupabaseClient, plan: StarPlan): Promise<number> {
  let written = 0;
  for (const entry of plan.entries) {
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

async function createTestUser(admin: SupabaseClient, suffix: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `star-merge-${suffix}@example.invalid`, password: crypto.randomUUID(), email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "test user missing");
  return created.data.user.id;
}

async function insertOrThrow(query: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await query;
  if (error) throw new Error(error.message);
}

/** Seeds user foods + refs for `userId`; returns the ref ids in `names` order. */
async function seedFoods(admin: SupabaseClient, userId: string, names: readonly string[]): Promise<string[]> {
  const foods = names.map((name) => ({ id: crypto.randomUUID(), user_id: userId, name,
    kind: "custom", per_100g: {}, allergen_tags: [] }));
  await insertOrThrow(admin.from("user_foods").insert(foods));
  const refs = foods.map((food) => ({ id: crypto.randomUUID(), kind: "user", user_food_id: food.id }));
  await insertOrThrow(admin.from("food_refs").insert(refs));
  return refs.map((ref) => ref.id);
}

async function branchCheck(admin: SupabaseClient): Promise<void> {
  const url = process.env.SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_REF)) throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  if (!url) throw new Error("--branch-check needs SUPABASE_URL pointed at the current branch");
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = await createTestUser(admin, suffix);
  const otherId = await createTestUser(admin, `${suffix}-other`);
  try {
    for (const id of [userId, otherId]) {
      await insertOrThrow(admin.from("user_settings").insert({ user_id: id,
        first_opened_at: new Date().toISOString() }));
    }
    const names = [`star merge favor ${suffix}`, `star merge eats ${suffix}`, `star merge avoid ${suffix}`];
    const refs = await seedFoods(admin, userId, names);
    // Another account's private food, starred by the test user (favorites_foods accepts any ref).
    const [foreignRef] = await seedFoods(admin, otherId, [`star merge foreign ${suffix}`]);
    // Seed the pre-existing marks for the "already eats" and "on Avoid" cases.
    for (const [name, status] of [[names[1], "eats"], [names[2], "avoid"]] as const) {
      const marked = await admin.rpc("set_food_membership", { p_user: userId,
        p_name_norm: name, p_status: status, p_note: null, p_rev: 1 });
      if (marked.error) throw new Error(marked.error.message);
    }
    await insertOrThrow(admin.from("favorites_foods").insert([...refs, foreignRef].map((ref, i) => ({
      user_id: userId, food_ref_id: ref, sort: i, deleted_at: null,
    }))));

    const own = (plan: StarPlan): StarPlan => ({ ...plan,
      entries: plan.entries.filter((e) => e.userId === userId) });
    const firstPlan = own(await planStarMerge(admin));
    if (firstPlan.entries.length !== 3) throw new Error(`expected 3 plan entries, found ${firstPlan.entries.length}`);
    if (firstPlan.skippedForeign < 1) throw new Error("the foreign star was not skipped");
    if (firstPlan.entries.some((e) => e.family.includes("foreign"))) {
      throw new Error("the foreign star's family reached the plan");
    }
    const firstWritten = await commitStarMerge(admin, firstPlan);
    if (firstWritten !== 1) throw new Error(`expected 1 write on the first run, wrote ${firstWritten}`);

    const marksAfter = await membershipMarks(admin, userId, names.map(baseFoodName));
    if (marksAfter.get(baseFoodName(names[0]))?.status !== "eats") {
      throw new Error("the neutral star was not favored");
    }
    if (marksAfter.get(baseFoodName(names[2]))?.status !== "avoid") {
      throw new Error("the star merge overrode an Avoid mark");
    }

    const secondWritten = await commitStarMerge(admin, own(await planStarMerge(admin)));
    if (secondWritten !== 0) throw new Error(`expected 0 writes on the second run, wrote ${secondWritten}`);

    console.log("star merge --branch-check: 1 favored, 1 already-favored skipped, "
      + "1 avoid skipped, 1 foreign star skipped, second run converged with 0 writes");
  } finally {
    for (const id of [userId, otherId]) {
      const removed = await admin.auth.admin.deleteUser(id);
      if (removed.error) console.warn(`star merge branch-check cleanup failed: ${removed.error.message}`);
    }
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
