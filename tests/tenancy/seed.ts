/**
 * Seeding and probing for the tenancy matrix (spec 3.2) and the policy mutation test (spec 3.4).
 * Every effect is measured with the admin client, so a user client that reports success without
 * a change (or an error after a change) cannot fool the check.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, resetUser, runSql } from "../helpers/supabase";
import { BUILDERS, type Fixture, type Row } from "./fixtures";
import manifest from "./table-ops.json";

export const OPS = ["select", "insert", "update", "delete"] as const;
export type Op = (typeof OPS)[number];
export type ProbeResult = { affected: number; error: string | null };

type Owner = "user_id" | { parent: string; fk: string };
const owners = manifest as Record<string, { owner: Owner }>;

export async function build(seedId: string, owner: string): Promise<Fixture> {
  const builder = BUILDERS[seedId];
  if (!builder) throw new Error(`no builder for seed id ${seedId}`);
  return builder(owner);
}

export async function find(f: Fixture): Promise<Row | null> {
  const { data, error } = await adminClient().from(f.table).select("*").match(f.match).maybeSingle();
  if (error) throw new Error(`read ${f.table}: ${error.message}`);
  return data as Row | null;
}

/**
 * Tables no API role may delete from (immutable coach Undo receipts, 20261216090000; taste-chip
 * receipts, 20261220090000): the test
 * removes their rows as the database owner, as the account cascade does.
 */
const OWNER_DELETE = new Set(["coach_action_receipts", "taste_chip_receipts", "taste_chip_holds"]);
const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;

async function deleteMatching(table: string, match: Row): Promise<void> {
  if (OWNER_DELETE.has(table)) {
    const where = Object.entries(match).map(([col, value]) => `${col} = ${literal(value)}`).join(" and ");
    runSql(`delete from public.${table} where ${where}`);
    return;
  }
  const { error } = await adminClient().from(table).delete().match(match);
  if (error) throw new Error(`clear ${table}: ${error.message}`);
}

/** Removes rows that would collide with the fixture (a singleton such as user_settings). */
export async function clear(f: Fixture): Promise<void> {
  await deleteMatching(f.table, f.clear ?? f.match);
}

async function seedFixture(f: Fixture): Promise<void> {
  await clear(f);
  const { error } = await adminClient().from(f.table).insert(f.row);
  if (error) throw new Error(`seed ${f.table}: ${error.message}`);
}

/**
 * Deletes every row the test users own in every declared table (children go by cascade), so
 * suites that run after this one start from the state test_reset_user would leave, and from none
 * of the rows in tables test_reset_user does not know (media_objects, job_runs, …).
 */
export async function purge(userIds: string[]): Promise<void> {
  // C5's private history row can restore a consumed mark into a generic plan_days write.
  // Remove only these fixture users' undo receipts and slot authority before resetUser.
  for (const table of ["recipe_consumed_undo_requests", "recipe_consumed_slot_state"]) {
    const { error } = await adminClient().from(table).delete().in("user_id", userIds);
    if (error) throw new Error(`purge ${table}: ${error.message}`);
  }
  // A selection's target FK has no cascade. Remove only these fixture accounts' selections
  // before resetUser deletes their target revisions, including a failed cross-owner probe.
  const selections = await adminClient().from("recipe_plan_selections")
    .delete().in("user_id", userIds);
  if (selections.error) throw new Error(`purge recipe_plan_selections: ${selections.error.message}`);
  // One user at a time: rows of one test user can reference the other's (cross-refs.test.ts), and
  // two concurrent cascading deletes over the same rows can deadlock.
  for (const id of userIds) await resetUser(id);
  const direct = Object.entries(owners).filter(([, v]) => v.owner === "user_id").map(([t]) => t);
  for (const table of direct) {
    if (OWNER_DELETE.has(table)) {
      runSql(`delete from public.${table} where user_id in (${userIds.map(literal).join(", ")})`);
      continue;
    }
    const { error } = await adminClient().from(table).delete().in("user_id", userIds);
    if (error) throw new Error(`purge ${table}: ${error.message}`);
  }
  // Deleting a target, shopping row or preference may bump these clocks after their place in the
  // manifest iteration (recipe_plan_state; Phase 18 W2b account_rules_clock). Remove the test
  // users' final clock rows last.
  for (const table of ["recipe_plan_state", "account_rules_clock"]) {
    const state = await adminClient().from(table).delete().in("user_id", userIds);
    if (state.error) throw new Error(`purge ${table}: ${state.error.message}`);
  }
}

export async function seed(seedId: string, owner: string): Promise<Fixture> {
  const f = await build(seedId, owner);
  await seedFixture(f);
  return f;
}

/**
 * Runs `op` as `client` (signed in as `actor`) against a fresh row owned by `owner` and returns
 * how many rows it reached: rows returned (select), the row present afterwards (insert), the row
 * changed (update) or the row gone (delete).
 */
export async function probe(
  client: SupabaseClient, seedId: string, op: Op, owner: string, actor: string,
): Promise<ProbeResult> {
  const f = await build(seedId, owner);
  if (op === "insert") {
    await clear(f);
    const { error } = await client.from(f.table).insert(f.row);
    return { affected: (await find(f)) ? 1 : 0, error: error?.message ?? null };
  }
  await seedFixture(f);
  const before = await find(f);
  if (op === "select") {
    const { data, error } = await client.from(f.table).select("*").match(f.match);
    return { affected: data?.length ?? 0, error: error?.message ?? null };
  }
  const { error } = op === "update"
    ? await client.from(f.table).update(f.touch(actor)).match(f.match)
    : await client.from(f.table).delete().match(f.match);
  const after = await find(f);
  const reached = op === "update"
    ? JSON.stringify(after) !== JSON.stringify(before)
    : after === null;
  return { affected: reached ? 1 : 0, error: error?.message ?? null };
}

/**
 * Every row `owner` owns in every declared table (children through their parents), as stored, in
 * a stable order. Comparing two snapshots catches a changed value, not only a changed count
 * (review r1 finding 5). Needs SUPABASE_TEST_DB_URL; a SQL error throws.
 */
export function accountSnapshot(owner: string): Record<string, unknown> {
  const tables = Object.keys(owners).sort();
  const selects = tables.map((t) => `select '${t}' as t, coalesce(json_agg(x order by x::text),
    '[]'::json) as rows from public.${t} x where ${ownerPredicate(t, owner, "x")}`).join(" union all ");
  return JSON.parse(runSql(`select json_object_agg(t, rows) from (${selects}) s`));
}

/**
 * SQL predicate (on `alias`) that is true for rows `owner` owns, following the manifest's owner
 * chain through parents (for example recipe_items → recipe_revisions → recipes).
 */
export function ownerPredicate(table: string, owner: string, alias = table, depth = 0): string {
  const declared = owners[table]?.owner;
  if (!declared) throw new Error(`${table} is not in table-ops.json`);
  if (declared === "user_id") return `${alias}.user_id = '${owner}'`;
  const p = `p${depth}`;
  return `exists (select 1 from public.${declared.parent} ${p} where ${p}.id = ${alias}.${declared.fk}
    and ${ownerPredicate(declared.parent, owner, p, depth + 1)})`;
}
