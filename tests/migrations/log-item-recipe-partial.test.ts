/**
 * #21 structural fix: a log item records, when written, whether it is a serving of a partly
 * measured recipe — so completing the recipe later never rewrites history. The DB case replays the
 * migration inside a rolled-back transaction on the LOCAL stack only; nothing is applied.
 */
// Refuses any non-local database before anything else runs.
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql } from "../helpers/supabase";

const NAME = "20261210090400_log_item_recipe_partial";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read(`supabase/migrations/${NAME}.sql`);
const DOWN = read(`supabase/migrations/down/${NAME}.down.sql`);
const sqlOnly = (text: string) => text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe(`${NAME}.sql`, () => {
  it("carries a stashed flag only for the same food and the same snapshot", () => {
    expect(UP).toContain("(v_carry::jsonb->>'f') = new.food_ref_id::text");
    expect(UP).toContain("(v_carry::jsonb->>'s') = md5(coalesce(new.snapshot, '{}'::jsonb)::text)");
  });

  it("adds two nullable columns and never touches _sync_upsert", () => {
    expect(UP).toContain("add column if not exists nutrition_partial boolean");
    expect(UP).toContain("add column if not exists recipe_rev integer");
    expect(sqlOnly(UP)).not.toMatch(/function\s+(public\.)?_sync_upsert/);
  });

  it("revokes every helper from client roles", () => {
    for (const fn of ["_log_item_recipe_partial(uuid, uuid)", "_log_item_carry_key(uuid)",
      "_log_item_stash_partial()", "_log_item_judge_partial()"]) {
      expect(UP).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
    }
  });

  it("down drops what up adds and grants nothing", () => {
    for (const part of ["log_items_judge_partial", "log_items_stash_partial", "nutrition_partial",
      "recipe_rev"]) expect(DOWN).toContain(part);
    expect(sqlOnly(DOWN)).not.toMatch(/grant/i);
  });
});

const UF = "7a5e0000-0000-4000-8000-000000000001";
const REF = "7a5e0000-0000-4000-8000-000000000002";
const ENTRY = "7a5e0000-0000-4000-8000-000000000003";
const ITEM = "7a5e0000-0000-4000-8000-000000000004";
const ITEM2 = "7a5e0000-0000-4000-8000-000000000005";
const UF_PLAIN = "7a5e0000-0000-4000-8000-000000000006";
const REF_PLAIN = "7a5e0000-0000-4000-8000-000000000007";
const UF_EMPTY = "7a5e0000-0000-4000-8000-000000000008";
const REF_EMPTY = "7a5e0000-0000-4000-8000-000000000009";
const ENTRY2 = "7a5e0000-0000-4000-8000-00000000000a";
const ITEM3 = "7a5e0000-0000-4000-8000-00000000000b";

function op(owner: string, kind: "create" | "update", baseRev: number | null, note: string,
  items: { id: string; seq: number }[]): string {
  const payload = { note, media_ref: null, eaten_at: "2041-01-01T12:00:00Z", tz: "UTC",
    local_date: "2041-01-01", slot: "snack", method: "search",
    items: items.map((item) => ({ ...item, qty: 1, unit: "g", food_ref_id: REF, grams: 100,
      snapshot: null, food_revision_id: null, portion_id: null, was_edited: false, confidence: null })) };
  const body = { op_id: crypto.randomUUID(), entity: "log_entries", entity_id: ENTRY, kind,
    base_rev: baseRev, client_ts: "2041-01-01T12:00:00Z", payload };
  return `select 'op:' || (apply_sync_op('${owner}', '${JSON.stringify(body)}'::jsonb)->>'status');`;
}
function opFor(owner: string, entry: string, kind: "create" | "update", baseRev: number | null,
  note: string, items: { id: string; seq: number; food_ref_id: string }[]): string {
  const payload = { note, media_ref: null, eaten_at: "2041-01-02T12:00:00Z", tz: "UTC",
    local_date: "2041-01-02", slot: "snack", method: "search",
    items: items.map((item) => ({ ...item, qty: 1, unit: "g", grams: 100, snapshot: null,
      food_revision_id: null, portion_id: null, was_edited: false, confidence: null })) };
  const body = { op_id: crypto.randomUUID(), entity: "log_entries", entity_id: entry, kind,
    base_rev: baseRev, client_ts: "2041-01-02T12:00:00Z", payload };
  return `select 'op:' || (apply_sync_op('${owner}', '${JSON.stringify(body)}'::jsonb)->>'status');`;
}
const emptyFlag = (label: string, id: string) =>
  `select '${label}:' || coalesce(nutrition_partial::text, 'null') || ':' || coalesce(recipe_rev::text, 'null')`
  + ` || ':' || coalesce(snapshot::text, 'null') from public.log_items where id = '${id}';`;
const flag = (label: string, id: string) =>
  `select '${label}:' || coalesce(nutrition_partial::text, 'null') || ':' || coalesce(recipe_rev::text, 'null')`
  + ` from public.log_items where id = '${id}';`;

describe.skipIf(!(HAS_DB && HAS_BRANCH))("the recorded partial flag on the local stack", () => {
  it("records partial at write, keeps it when the recipe is later completed, and ignores a client flip", async () => {
    const owner = (await ensureUser("a")).id;
    const out = runSql(["begin;", UP,
      `insert into public.user_foods (id, user_id, name, kind, per_100g)
         values ('${UF}', '${owner}', 'Half stew', 'recipe', '{"energy_kcal": 50}');`,
      `insert into public.food_refs (id, kind, user_food_id) values ('${REF}', 'user', '${UF}');`,
      `insert into public.recipes (id, user_id, name, servings, rev) values ('${UF}', '${owner}', 'Half stew', 1, 1);`,
      `insert into public.recipe_revisions (recipe_id, rev, nutrients_per_serving)
         values ('${UF}', 1, '{"energy_kcal": 50, "coverage": 0.5}');`,
      op(owner, "create", null, "first", [{ id: ITEM, seq: 0 }]),
      flag("created", ITEM),
      // The recipe is completed: revision 2 at coverage 1, and the twin's numbers move.
      `update public.recipes set rev = 2 where id = '${UF}';`,
      `insert into public.recipe_revisions (recipe_id, rev, nutrients_per_serving)
         values ('${UF}', 2, '{"energy_kcal": 100, "coverage": 1}');`,
      `update public.user_foods set per_100g = '{"energy_kcal": 100}' where id = '${UF}';`,
      // A note edit replaces the items wholesale; the untouched item keeps its frozen snapshot.
      op(owner, "update", 1, "second", [{ id: ITEM, seq: 0 }, { id: ITEM2, seq: 1 }]),
      flag("kept", ITEM), flag("new", ITEM2),
      `update public.log_items set nutrition_partial = false, recipe_rev = 9 where id = '${ITEM}';`,
      flag("flipped", ITEM),
      // The item's snapshot is recomputed under the completed revision: new numbers, judged afresh.
      `update public.log_items set snapshot = public.compute_item_snapshot(food_ref_id, grams)
         where id = '${ITEM}';`,
      flag("recomputed", ITEM),
      // Same item id, same snapshot bytes, a DIFFERENT food: judged afresh, never inherited.
      `insert into public.user_foods (id, user_id, name, kind, per_100g)
         values ('${UF_PLAIN}', '${owner}', 'Plain rice', 'custom', '{"energy_kcal": 130}');`,
      `insert into public.food_refs (id, kind, user_food_id) values ('${REF_PLAIN}', 'user', '${UF_PLAIN}');`,
      `do $$ declare v_snap jsonb; begin
         select snapshot into v_snap from public.log_items where id = '${ITEM}';
         delete from public.log_items where id = '${ITEM}';
         insert into public.log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot)
           values ('${ITEM}', '${ENTRY}', 0, 1, 'g', '${REF_PLAIN}', 100, v_snap);
       end $$;`,
      flag("swapped", ITEM),
      // Review round 9: a recipe with NOTHING measured logs an empty snapshot, partial. After the
      // recipe gains nutrition, a note-only edit must leave that serving exactly as logged.
      `insert into public.user_foods (id, user_id, name, kind, per_100g)
         values ('${UF_EMPTY}', '${owner}', 'Unmeasured stew', 'recipe', '{}');`,
      `insert into public.food_refs (id, kind, user_food_id) values ('${REF_EMPTY}', 'user', '${UF_EMPTY}');`,
      `insert into public.recipes (id, user_id, name, servings, rev) values ('${UF_EMPTY}', '${owner}', 'Unmeasured stew', 1, 1);`,
      `insert into public.recipe_revisions (recipe_id, rev, nutrients_per_serving) values ('${UF_EMPTY}', 1, '{"coverage": 0}');`,
      opFor(owner, ENTRY2, "create", null, "plain", [{ id: ITEM3, seq: 0, food_ref_id: REF_EMPTY }]),
      emptyFlag("empty_logged", ITEM3),
      `update public.recipes set rev = 2 where id = '${UF_EMPTY}';`,
      `insert into public.recipe_revisions (recipe_id, rev, nutrients_per_serving) values ('${UF_EMPTY}', 2, '{"energy_kcal": 300, "coverage": 1}');`,
      `update public.user_foods set per_100g = '{"energy_kcal": 300}' where id = '${UF_EMPTY}';`,
      opFor(owner, ENTRY2, "update", 1, "note only", [{ id: ITEM3, seq: 0, food_ref_id: REF_EMPTY }]),
      emptyFlag("empty_after_note", ITEM3),
      `select 'client_exec:' || bool_or(has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('anon', p.oid, 'execute'))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '\\_log\\_item\\_%';`,
      "rollback;"].join("\n"));
    const lines = out.split("\n");
    expect(lines.filter((line) => line.startsWith("op:"))).toEqual(
      ["op:applied", "op:applied", "op:applied", "op:applied"]);
    expect(lines).toContain("created:true:1");
    expect(lines).toContain("kept:true:1");
    expect(lines).toContain("new:false:2");
    expect(lines).toContain("flipped:true:1");
    expect(lines).toContain("recomputed:false:2");
    expect(lines).toContain("swapped:null:null");
    expect(lines).toContain("empty_logged:true:1:{}");
    expect(lines).toContain("empty_after_note:true:1:{}");
    // The RPC manifest (tests/tenancy/rpc-matrix.test.ts) stays clean: no client role executes them.
    expect(lines).toContain("client_exec:false");
  });
});
