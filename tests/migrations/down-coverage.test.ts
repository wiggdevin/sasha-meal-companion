// Audit 2026-09-13, finding #93: six down migrations had zero test coverage of any kind — no
// readFileSync, no string assertion, anywhere in tests/. Modeled on the static-assertion pattern
// tests/coach/migration.test.ts and tests/expenditure/migration.test.ts already use for their own
// up/down pairs: read the real SQL text and assert its drop statements, order and — for the two
// catalog RLS migrations — the one detail a careless copy-paste would get wrong (whether the down
// file disables RLS outright, or only undoes the later `force` increment).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const up = (f: string) => readFileSync(path.join(root, "supabase/migrations", f), "utf8");
const down = (f: string) => readFileSync(path.join(root, "supabase/migrations/down", f), "utf8");

describe("20260912090200_catalog_grants.sql", () => {
  const UP = up("20260912090200_catalog_grants.sql");
  const DOWN = down("20260912090200_catalog_grants.down.sql");
  const TABLES = ["catalog_versions", "catalog_foods", "catalog_food_revisions",
    "catalog_nutrients", "catalog_food_nutrients", "catalog_barcodes", "catalog_portions",
    "catalog_ingredients", "catalog_dri"];

  it("forces RLS and grants service_role on all nine catalog tables", () => {
    for (const t of TABLES) expect(UP).toContain(t);
    expect(UP).toContain("alter table %I enable row level security");
    expect(UP).toContain("alter table %I force row level security");
    expect(UP).toContain("for select to authenticated using (true)");
    expect(UP).toContain("grant all on table %I to service_role");
  });

  it("down only undoes the force+service_role increment — RLS and the read policy stay", () => {
    expect(DOWN).toContain("alter table %I no force row level security");
    expect(DOWN).toContain("revoke all on table %I from service_role");
    // Phase 0 (20260911000500_rls.sql) put RLS and the <table>_read policy in place; 090200 only
    // added `force` on top. Undoing 090200 must not disable RLS or drop that policy.
    expect(DOWN).not.toContain("disable row level security");
    expect(DOWN).not.toContain("drop policy");
  });

  it("down also revokes the service_role sequence grants 090200 added", () => {
    expect(DOWN).toContain("revoke all on sequence %I from service_role");
    expect(DOWN).not.toContain("grant all on sequence");
  });
});

describe("20260919090000_phase3_recipes_favorites.sql", () => {
  const DOWN = down("20260919090000_phase3_recipes_favorites.down.sql");

  it("drops exactly the columns the up migration added, per table", () => {
    expect(DOWN).toContain("alter table recipes drop column updated_at");
    expect(DOWN).toContain(
      "alter table favorites_meals drop column deleted_at, drop column updated_at, " +
      "drop column created_at");
    expect(DOWN).toContain(
      "alter table favorites_recipes drop column deleted_at, drop column updated_at, " +
      "drop column created_at, drop column rev");
    expect(DOWN).toContain(
      "alter table favorites_foods drop column deleted_at, drop column updated_at, " +
      "drop column created_at, drop column rev");
  });

  it("never drops favorites_meals.rev — Phase 0 created that column, not this migration", () => {
    expect(DOWN).not.toMatch(/favorites_meals[^;]*drop column rev/);
    expect(DOWN).not.toMatch(/drop table/i);
  });
});

describe("20260919090100_phase3_barcode_cache.sql", () => {
  const UP = up("20260919090100_phase3_barcode_cache.sql");
  const DOWN = down("20260919090100_phase3_barcode_cache.down.sql");

  it("creates catalog_barcode_lookups with its stale index and the provider-write function", () => {
    expect(UP).toContain("create table if not exists catalog_barcode_lookups");
    expect(UP).toContain("create index if not exists catalog_barcode_lookups_stale");
    expect(UP).toContain("create or replace function catalog_write_provider_revision");
  });

  it("down drops the function, the index and the table it created — nothing else", () => {
    expect(DOWN).toContain("drop function if exists catalog_write_provider_revision(uuid, text, text, jsonb)");
    expect(DOWN).toContain("drop index if exists catalog_barcode_lookups_stale");
    expect(DOWN).toContain("drop table if exists catalog_barcode_lookups");
    // The cached OFF/FDC rows this function writes into OTHER tables (catalog_foods etc.) are
    // Phase 1 tables this migration doesn't own — the down file must not touch them.
    expect(DOWN).not.toContain("catalog_foods");
    expect(DOWN).not.toContain("catalog_versions");
  });
});

describe("20260920090000_phase4_ai_calls_capture.sql", () => {
  const UP = up("20260920090000_phase4_ai_calls_capture.sql");
  const DOWN = down("20260920090000_phase4_ai_calls_capture.down.sql");

  it("widens ai_calls_status_check to the six Phase 4 statuses", () => {
    expect(UP).toContain(
      "check (status in ('ok','schema_invalid','provider_error','timeout','blocked','error'))");
    expect(UP).toContain("create index if not exists ai_calls_idem");
    expect(UP).toContain("create or replace function ai_calls_today");
  });

  it("down narrows rows back to 'error' before re-adding the Phase 0 two-value check", () => {
    expect(DOWN).toContain("drop function if exists ai_calls_today(uuid, text)");
    expect(DOWN).toContain("drop index if exists ai_calls_idem");
    expect(DOWN).toContain(
      "update ai_calls set status = 'error'\n  where status in " +
      "('schema_invalid','provider_error','timeout','blocked')");
    expect(DOWN).toContain("check (status in ('ok','error'))");
    // The narrowing UPDATE must run before the stricter two-value check is re-added, or any row
    // still carrying a Phase 4-only status would make the ADD CONSTRAINT itself fail.
    expect(DOWN.indexOf("update ai_calls set status = 'error'"))
      .toBeLessThan(DOWN.indexOf("add constraint ai_calls_status_check"));
  });
});

describe("20260920090100_phase4_media_bucket.sql", () => {
  const UP = up("20260920090100_phase4_media_bucket.sql");
  const DOWN = down("20260920090100_phase4_media_bucket.down.sql");

  it("creates the media bucket, the owner-folder policy and media_objects with RLS", () => {
    expect(UP).toContain("insert into storage.buckets");
    expect(UP).toContain("create policy media_own_folder on storage.objects");
    expect(UP).toContain("create table if not exists media_objects");
    expect(UP).toContain("alter table media_objects enable row level security");
  });

  it("down drops media_objects and the folder policy, but never her uploaded files", () => {
    expect(DOWN).toContain("drop table if exists media_objects");
    expect(DOWN).toContain("drop policy if exists media_own_folder on storage.objects");
    // Supabase forbids a direct SQL delete on storage tables — the bucket row (and anything in
    // it) is intentionally left alone, not swept up here.
    expect(DOWN).not.toContain("storage.buckets");
    expect(DOWN).not.toContain("storage.objects\ndrop");
    expect(DOWN).not.toMatch(/delete from storage\./);
  });
});

describe("20261008090000_catalog_rls_lint.sql", () => {
  const UP = up("20261008090000_catalog_rls_lint.sql");
  const DOWN = down("20261008090000_catalog_rls_lint.down.sql");
  const TABLES = ["catalog_synonyms", "catalog_barcode_lookups"];

  it("gives catalog_synonyms and catalog_barcode_lookups the same forced-RLS shape as catalog_grants", () => {
    for (const t of TABLES) expect(UP).toContain(t);
    expect(UP).toContain("alter table %I enable row level security");
    expect(UP).toContain("alter table %I force row level security");
  });

  it("down fully removes the RLS shape this migration added — unlike catalog_grants' down", () => {
    // Unlike 20260912090200_catalog_grants.down.sql (which leaves RLS on because Phase 0 already
    // had it enabled), RLS was OFF for these two tables before this migration — so undoing it
    // means dropping the policy AND disabling RLS, not just un-forcing it.
    expect(DOWN).toContain("drop policy if exists");
    expect(DOWN).toContain("alter table %I no force row level security");
    expect(DOWN).toContain("alter table %I disable row level security");
  });
});

describe("20261026090200_retire_legacy_store.sql", () => {
  const UP = up("20261026090200_retire_legacy_store.sql");
  const DOWN = down("20261026090200_retire_legacy_store.down.sql");
  const TABLES = ["foods", "days", "settings"];

  it("drops the three retired singleton tables and touches no account-owned one", () => {
    for (const t of TABLES) expect(UP).toContain(`drop table if exists public.${t};`);
    expect(UP).not.toMatch(/plan_days|user_settings|user_foods/);
  });

  it("restores every object the production dump recorded for those tables", () => {
    // Read-only backup 2026-09-20T183149Z-cdffe97b.sql: table DDL (6985/7178/7368), primary key
    // (465415/465519/465671), RLS enable (467853/467992/468180) and the three default grants
    // (470284-470286/470373-470375/470460-470462). Recreating the table and RLS alone left the
    // grants behind, so a rollback answered every client 42501 instead of an empty table.
    for (const t of TABLES) {
      expect(DOWN, t).toContain(`create table if not exists public.${t} (`);
      expect(DOWN, t).toContain(`constraint ${t}_pkey primary key`);
      expect(DOWN, t).toContain(`alter table public.${t} enable row level security;`);
      expect(DOWN, t).toContain(
        `grant all on table public.${t} to anon, authenticated, service_role;`);
    }
  });

  it("states in the file that the dump held no policy, trigger or function for them", () => {
    expect(DOWN).toMatch(/no (row-level )?polic/i);
    expect(DOWN).toMatch(/trigger/i);
    expect(DOWN).toMatch(/function/i);
    expect(DOWN).not.toContain("create policy");
  });

  it("mirrors the dump's own column types — days.date is text, not date", () => {
    expect(DOWN).toMatch(/create table if not exists public\.days \(\n\s*date text not null,/);
    expect(DOWN).toMatch(/create table if not exists public\.foods \(\n\s*id text not null,/);
    expect(DOWN).toMatch(/create table if not exists public\.settings \(\n\s*id text not null,/);
  });

  it("restores schema only — never a data row", () => {
    expect(DOWN).not.toMatch(/insert into|copy public\./i);
  });
});

describe("20261202090000_scope_recipe_food_ref_clock.sql", () => {
  const UP = up("20261202090000_scope_recipe_food_ref_clock.sql");
  const DOWN = down("20261202090000_scope_recipe_food_ref_clock.down.sql");

  it("scopes private ref changes to their owner while preserving shared invalidation", () => {
    expect(UP).toContain("for each row execute function public.recipe_plan_bump_food_ref_state()");
    expect(UP).toContain("where f.id = v_ref.user_food_id");
    expect(UP).toContain("where user_id is not null");
  });

  it("down restores the previous global statement trigger", () => {
    expect(DOWN).toContain("drop function if exists public.recipe_plan_bump_food_ref_state()");
    expect(DOWN).toContain("for each statement execute function public.recipe_plan_bump_global_state()");
    expect(DOWN).not.toContain("drop table");
  });
});

describe("20261220090300_ai_calls_permission_denied.sql", () => {
  const UP = up("20261220090300_ai_calls_permission_denied.sql");
  const DOWN = down("20261220090300_ai_calls_permission_denied.down.sql");

  it("widens the check to the seventh AiStatus value, keeping the six Phase 4 ones", () => {
    expect(UP).toContain("check (status in\n    ('ok', 'schema_invalid', 'provider_error', "
      + "'timeout', 'blocked', 'error', 'permission_denied'))");
  });

  it("down narrows rows back to 'error' before re-adding the six-value check", () => {
    expect(DOWN).toContain("update ai_calls set status = 'error' where status = 'permission_denied'");
    expect(DOWN).toContain(
      "check (status in ('ok', 'schema_invalid', 'provider_error', 'timeout', 'blocked', 'error'))");
    // The narrowing UPDATE must run before the stricter check is re-added, or any row still
    // carrying 'permission_denied' would make the ADD CONSTRAINT itself fail.
    expect(DOWN.indexOf("update ai_calls set status = 'error'"))
      .toBeLessThan(DOWN.indexOf("add constraint ai_calls_status_check"));
  });
});
