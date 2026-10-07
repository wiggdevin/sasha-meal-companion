/**
 * t17 gap 1 on a real Postgres: migration 20261211090000_log_items_unknown_mass applied inside ONE
 * transaction that is always rolled back, so the local test database is left exactly as it was.
 *
 * Proves, through the installed `_sync_upsert` (the path commit and sync both take): an item with
 * an unknown mass stores grams null with its qty and unit; its snapshot is the sent per-unit
 * numbers × qty (unknown codes and non-numbers ignored), or `{}`; an edit that resends it without
 * the map keeps or rescales the frozen snapshot; `daily_energy` counts the unknown one as
 * unknown (coverage), never 0; a catalog-pinned item may not drop its mass; and the down
 * migration restores the old function and NOT NULL.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HAS_DB, pgEnvFromUrl } from "@/tests/helpers/supabase";

const DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";
const LOCAL_DB = HAS_DB && (() => {
  try { return ["127.0.0.1", "localhost"].includes(new URL(DB_URL).hostname); }
  catch { return false; }
})();

const USER = "7a170000-0000-4000-8000-000000000001";
const FOOD = "7a170000-0000-4000-8000-000000000002";
const REF = "7a170000-0000-4000-8000-000000000003";
const ENTRY = "7a170000-0000-4000-8000-000000000004";
const ITEM_A = "7a170000-0000-4000-8000-000000000005";
const ITEM_B = "7a170000-0000-4000-8000-000000000006";
const DATE = "2099-11-02";
const CATALOG_REF = "7a170000-0000-4000-8000-000000000007";
const ENTRY_2 = "7a170000-0000-4000-8000-000000000008";
const ITEM_C = "7a170000-0000-4000-8000-000000000009";

function payload(items: Record<string, unknown>[]): string {
  return JSON.stringify({ eaten_at: `${DATE}T12:00:00Z`, tz: "UTC", local_date: DATE,
    slot: "meal-1", method: "search", note: null, media_ref: null, items }).replaceAll("'", "''");
}

const POUCH_PER_UNIT = { energy_kcal: 78, protein: 2, carbohydrate: 14, fat_total: 1,
  not_a_code: 5, fiber_total: "x" };

/** Runs the script in one rolled-back transaction; returns every `R|<tag>|<json>` line. */
function run(): Map<string, unknown> {
  const script = `
\\set ON_ERROR_STOP 1
begin;
select to_regclass('public.daily_energy') is null as need_energy \\gset
\\if :need_energy
\\i supabase/migrations/20261210090000_daily_energy.sql
\\endif
-- 20261210090400 (recipe partial marks) adds log_items triggers that fire on every write here.
select not exists (select 1 from information_schema.columns where table_schema = 'public'
  and table_name = 'log_items' and column_name = 'nutrition_partial') as need_partial \\gset
\\if :need_partial
\\i supabase/migrations/20261210090400_log_item_recipe_partial.sql
\\endif
\\i supabase/migrations/20261211090000_log_items_unknown_mass.sql
insert into auth.users (id, email) values ('${USER}', 't17-unknown-mass@meal-companion.test');
insert into user_foods (id, user_id, kind, name, per_100g, rev)
  values ('${FOOD}', '${USER}', 'custom', 'Pouch', '{}'::jsonb, 1);
insert into food_refs (id, kind, user_food_id) values ('${REF}', 'user', '${FOOD}');
insert into catalog_foods (id, source, source_id) values (-17017, 'test', 't17-catalog');
insert into food_refs (id, kind, catalog_food_id) values ('${CATALOG_REF}', 'catalog', -17017);
select _sync_upsert('${USER}', 'log_entries', '${ENTRY}', '${payload([
    { id: ITEM_A, seq: 1, qty: 2, unit: "pouch", food_ref_id: REF, grams: null,
      per_unit: POUCH_PER_UNIT },
    { id: ITEM_B, seq: 2, qty: 1, unit: "pouch", food_ref_id: REF, grams: null },
  ])}'::jsonb, 1) is not null as wrote \\gset
select 'R|created|' || jsonb_agg(jsonb_build_object('grams', grams, 'qty', qty, 'unit', unit,
  'snapshot', snapshot) order by seq)::text from log_items where entry_id = '${ENTRY}';
select 'R|energy|' || to_jsonb(d)::text from daily_energy d where d.user_id = '${USER}';
select _sync_upsert('${USER}', 'log_entries', '${ENTRY}', '${payload([
    { id: ITEM_A, seq: 1, qty: 3, unit: "pouch", food_ref_id: REF, grams: null },
  ])}'::jsonb, 2) is not null as wrote \\gset
select 'R|rescaled|' || jsonb_agg(snapshot order by seq)::text from log_items where entry_id = '${ENTRY}';
-- t17 round 4 (GPT-6 BLOCK 1): a count edit recomputes from the EXACT per-unit number, rounding
-- once. 1.0001 g protein per unit: at 0.25 the amount rounds to 0.2500, and a rescale of that
-- rounded amount to 0.5 would say 0.5000; per-unit × count says 0.5001.
select _sync_upsert('${USER}', 'log_entries', '${ENTRY_2}', '${payload([
    { id: ITEM_C, seq: 1, qty: 0.25, unit: "scoop", food_ref_id: REF, grams: null,
      per_unit: { protein: 1.0001 } },
  ])}'::jsonb, 1) is not null as wrote \\gset
select 'R|quarter|' || snapshot::text from log_items where id = '${ITEM_C}';
select _sync_upsert('${USER}', 'log_entries', '${ENTRY_2}', '${payload([
    { id: ITEM_C, seq: 1, qty: 0.5, unit: "scoop", food_ref_id: REF, grams: null },
  ])}'::jsonb, 2) is not null as wrote \\gset
select 'R|half|' || snapshot::text from log_items where id = '${ITEM_C}';
select _sync_upsert('${USER}', 'log_entries', '${ENTRY_2}', '${payload([
    { id: ITEM_C, seq: 1, qty: 3, unit: "scoop", food_ref_id: REF, grams: null, per_unit: null },
  ])}'::jsonb, 3) is not null as wrote \\gset
select 'R|three|' || snapshot::text from log_items where id = '${ITEM_C}';
select 'R|recompute_drops_inexact|' || recompute_unit_snapshot(
  '{"protein": {"amount": 0.25, "basis": "per_unit"}, "fat_total": {"amount": 1, "basis": "per_100g", "per_unit": 2}}'::jsonb,
  2)::text;
delete from log_entries where id = '${ENTRY_2}';
select 'R|item_snapshot_null|' || compute_item_snapshot('${REF}', null)::text;
create temp table t17_out (tag text, val jsonb);
do $$ begin
  begin
    -- The CHECK runs before the foreign key, so no real revision is needed to prove it.
    insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot,
                           food_revision_id)
      values (gen_random_uuid(), '${ENTRY}', 9, 1, 'g', '${REF}', null, '{}', -1);
    insert into t17_out values ('catalog_null', '"accepted"');
  exception when check_violation then insert into t17_out values ('catalog_null', '"refused"');
             when foreign_key_violation then insert into t17_out values ('catalog_null', '"fk"');
  end;
  -- t17 round 3: a CATALOG ref with no revision or portion still may not drop its mass, and
  -- the per_unit path (through _sync_upsert) is refused for it the same way.
  begin
    insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot)
      values (gen_random_uuid(), '${ENTRY}', 11, 1, 'slice', '${CATALOG_REF}', null, '{}');
    insert into t17_out values ('catalog_ref_null', '"accepted"');
  exception when check_violation then insert into t17_out values ('catalog_ref_null', '"refused"');
  end;
  begin
    perform _sync_upsert('${USER}', 'log_entries', '${ENTRY}', '${payload([
    { id: ITEM_B, seq: 1, qty: 1, unit: "slice", food_ref_id: CATALOG_REF, grams: null,
      per_unit: { energy_kcal: 9999 } },
  ])}'::jsonb, 3);
    insert into t17_out values ('catalog_ref_sync', '"accepted"');
  exception when check_violation then insert into t17_out values ('catalog_ref_sync', '"refused"');
  end;
  begin
    insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot)
      values (gen_random_uuid(), '${ENTRY}', 10, 1, 'g', '${REF}', 0, '{}');
    insert into t17_out values ('zero_grams', '"accepted"');
  exception when check_violation then insert into t17_out values ('zero_grams', '"refused"');
  end;
end $$;
select 'R|' || tag || '|' || val::text from t17_out;
delete from log_entries where id = '${ENTRY}';
\\i supabase/migrations/down/20261211090000_log_items_unknown_mass.down.sql
select 'R|down|' || jsonb_build_object(
  'nullable', (select is_nullable from information_schema.columns
                where table_schema = 'public' and table_name = 'log_items' and column_name = 'grams'),
  'patched', position('compute_unit_snapshot' in
    pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)) > 0)::text;
rollback;
`;
  const out = execFileSync("psql", ["-X", "-q", "-At"], {
    input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...pgEnvFromUrl(DB_URL) },
  });
  return parse(out);
}

function parse(out: string): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const line of out.split("\n")) {
    const at = line.indexOf("R|");
    if (at < 0) continue;
    const [, tag, ...rest] = line.slice(at).split("|");
    const json = rest.join("|");
    found.set(tag, JSON.parse(json));
  }
  return found;
}

/** psql's own error text is the useful failure message. */
function runWithNotices(): Map<string, unknown> {
  try {
    return run();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`psql failed: ${err.stderr ?? ""}`);
  }
}

describe.skipIf(!LOCAL_DB)("log_items with an unknown mass on a local test database", () => {
  it("stores grams null, per-unit nutrients or {}, unknown energy, and rolls back cleanly", () => {
    const r = runWithNotices();
    const created = r.get("created") as { grams: number | null; qty: number; unit: string;
      snapshot: Record<string, { amount: number | null; basis: string; unit: string }> }[];
    expect(created.map((i) => i.grams)).toEqual([null, null]);
    expect(created.map((i) => [i.qty, i.unit])).toEqual([[2, "pouch"], [1, "pouch"]]);
    expect(Object.keys(created[0].snapshot).sort())
      .toEqual(["carbohydrate", "energy_kcal", "fat_total", "protein"]);
    expect(created[0].snapshot.energy_kcal).toMatchObject({ amount: 156, basis: "per_unit",
      unit: "kcal" });
    expect(created[0].snapshot.protein.amount).toBe(4);
    expect(created[1].snapshot).toEqual({});

    expect(r.get("energy")).toMatchObject({ local_date: DATE, amount: 156, items_with_value: 1,
      items_total: 2, coverage: 0.5 });

    const [rescaled] = r.get("rescaled") as Record<string, { amount: number }>[];
    expect(rescaled.energy_kcal.amount).toBe(234);
    expect(rescaled.carbohydrate.amount).toBe(42);
    expect(rescaled.protein).toMatchObject({ amount: 6, per_unit: 2, basis: "per_unit" });

    // Round 4: per-unit × count, rounded once, at every count — never a rescaled rounded amount.
    const protein = (tag: string) => (r.get(tag) as Record<string, { amount: number;
      per_unit: number }>).protein;
    expect(protein("quarter")).toMatchObject({ amount: 0.25, per_unit: 1.0001 });
    expect(protein("half")).toMatchObject({ amount: 0.5001, per_unit: 1.0001 });
    expect(protein("three")).toMatchObject({ amount: 3.0003, per_unit: 1.0001 });
    // An entry with no exact per-unit number, or not a per-unit one, is unknown — dropped.
    expect(r.get("recompute_drops_inexact")).toEqual({});
    expect(r.get("item_snapshot_null")).toEqual({});
    // A catalog portion always has a mass; 0 g is still a legal measured mass (the old check).
    expect(r.get("catalog_null")).toBe("refused");
    expect(r.get("zero_grams")).toBe("accepted");
    expect(r.get("catalog_ref_null")).toBe("refused");
    expect(r.get("catalog_ref_sync")).toBe("refused");
    expect(r.get("down")).toEqual({ nullable: "NO", patched: false });
  });
});
