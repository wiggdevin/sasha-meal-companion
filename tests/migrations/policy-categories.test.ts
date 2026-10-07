/**
 * T1 §3 and §4 — the two migrations that make the "Off the plan" switches mean what they say.
 *
 * Static assertions over the SQL text, the pattern tests/migrations/plan-days-item-overrides.test.ts
 * already uses: these files are applied to production by hand (ruling R11a), so the check that can
 * run in CI is that the text says what the plan says. A real apply is covered by the integration
 * suite when SUPABASE_TEST_DB_URL is set.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const CATEGORIES = read("supabase/migrations/20261018090000_policy_categories.sql");
const CATEGORIES_DOWN = read("supabase/migrations/down/20261018090000_policy_categories.down.sql");
const PROFILE = read("supabase/migrations/20261018090100_constraint_profile_all_categories.sql");
const PROFILE_DOWN =
  read("supabase/migrations/down/20261018090100_constraint_profile_all_categories.down.sql");
const SEARCH = read("supabase/migrations/20261018090200_catalog_search_policy_categories.sql");
const SEARCH_DOWN =
  read("supabase/migrations/down/20261018090200_catalog_search_policy_categories.down.sql");

const FIVE = "{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}";

describe("20261018090000_policy_categories", () => {
  it("adds the column NULLABLE, so never-annotated and annotated-clean stay different facts", () => {
    const sql = sqlOnly(CATEGORIES);
    expect(sql).toContain("alter table catalog_food_revisions");
    expect(sql).toMatch(/add column if not exists policy_categories text\[\];/);
    expect(sql).not.toMatch(/policy_categories text\[\][^;]*not null/);
    expect(sql).not.toMatch(/policy_categories text\[\][^;]*default/);
  });

  it("keeps the RPC's security boundary — definer, pinned search_path, no public grant", () => {
    const sql = sqlOnly(CATEGORIES);
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public");
    expect(sql).not.toMatch(/grant\s+execute[\s\S]*to\s+(public|anon)\b/);
  });

  it("teaches the provider-write RPC to carry policyCategories onto the row", () => {
    const sql = sqlOnly(CATEGORIES);
    expect(sql).toContain("jsonb_array_elements_text(p_draft->'policyCategories')");
    expect(sql).toContain("policy_categories = excluded.policy_categories");
  });

  it("stores NULL when the draft omits the key, '{}' only when it really is an array", () => {
    // The deploy window: the migrations land before the app does, so the OLD barcode writer sends
    // drafts with no `policyCategories` at all. Storing '{}' for those would mark every scan in
    // that window "annotated and clean", and nothing would ever derive for them again.
    const sql = sqlOnly(CATEGORIES);
    expect(sql).toMatch(/jsonb_typeof\(p_draft->'policyCategories'\)\s*=\s*'array'/);
    expect(sql).toMatch(/else\s+null\s+end/);
  });

  it("keeps every field 20261014090000 taught the same RPC to write", () => {
    const sql = sqlOnly(CATEGORIES);
    for (const line of ["category = excluded.category", "catalog_search_doc(v_desc, v_brand, v_category)",
      "perform get_or_create_food_ref(p_user_id, 'catalog', v_food_id, null)"]) {
      expect(sql).toContain(line);
    }
  });

  it("down drops the column and restores the previous function body", () => {
    const sql = sqlOnly(CATEGORIES_DOWN);
    expect(sql).toContain("drop column if exists policy_categories");
    expect(sql).toContain("create or replace function catalog_write_provider_revision");
    expect(sql).not.toContain("policyCategories");
  });
});

describe("20261018090100_constraint_profile_all_categories", () => {
  it("sets all five keys as the table default", () => {
    expect(sqlOnly(PROFILE)).toContain(`set default '${FIVE}'`);
  });

  it("adds any missing key to an existing row without dropping what is already there", () => {
    const sql = sqlOnly(PROFILE);
    expect(sql).toContain("update constraint_profiles");
    expect(sql).toContain("unnest(banned_categories");
    expect(sql).toContain("array_agg(distinct key order by key)");
  });

  it("bumps rev, so a client holding the old array cannot silently write it back", () => {
    // `rev` is the compare-and-swap arbiter for PUT /api/constraints. Without a bump, a tab that
    // loaded the one-key profile before the migration and saves a condition afterwards would PUT
    // `{simple_sugars}` at the matching rev and switch four rules back off with no warning.
    expect(sqlOnly(PROFILE)).toMatch(/rev\s*=\s*rev\s*\+\s*1/);
  });

  it("down restores the Phase 0 default and leaves her rows alone", () => {
    const sql = sqlOnly(PROFILE_DOWN);
    expect(sql).toContain("set default '{simple_sugars}'");
    expect(sql).not.toContain("update constraint_profiles");
  });

  it("DEFAULT_PROFILE and the table default name the same five keys", () => {
    expect([...DEFAULT_PROFILE.banned_categories].sort().join(","))
      .toBe(FIVE.slice(1, -1).split(",").sort().join(","));
  });
});

describe("20261018090200_catalog_search_policy_categories", () => {
  it("drops and re-creates catalog_search, because a returns-table column cannot be replaced", () => {
    const sql = sqlOnly(SEARCH);
    expect(sql).toContain("drop function if exists public.catalog_search(text, text, text, integer)");
    expect(sql).toContain("create function public.catalog_search(");
    expect(sql).not.toContain("create or replace function public.catalog_search(");
  });

  it("returns both the keys and the provider category, so a hit can derive its own", () => {
    const sql = sqlOnly(SEARCH);
    expect(sql).toContain("policy_categories text[],");
    expect(sql).toContain("category text,");
    expect(sql).toContain("r.policy_categories");
    expect(sql).toContain("r.category");
    expect(sql).toMatch(/pref_status, category, policy_categories,/);
  });

  it("keeps the score expression and both trigram GUCs byte for byte", () => {
    const sql = sqlOnly(SEARCH);
    expect(sql).toContain("round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep");
    expect(sql).toContain("+ 0.10 * f_prior  + 0.05 * f_quality + 0.05 * f_eats, 6) as score");
    expect(sql).toContain("set pg_trgm.similarity_threshold = 0.25");
    expect(sql).toContain("set pg_trgm.word_similarity_threshold = 0.45");
    expect(sql).toContain("catalog_expand_query(p_q)");
  });

  it("keeps catalog_search security invoker with its pinned search_path", () => {
    const sql = sqlOnly(SEARCH);
    expect(sql).toContain("security invoker");
    expect(sql).toContain("set search_path = public, extensions, pg_temp");
    expect(sql).not.toContain("security definer");
  });

  it("re-applies the grants a drop would otherwise have taken with it", () => {
    const sql = sqlOnly(SEARCH);
    expect(sql).toContain("revoke execute on function public.catalog_search(text, text, text, integer) from public, anon");
    expect(sql).toContain("grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role");
  });

  it("down restores the function without the column, grants included", () => {
    const sql = sqlOnly(SEARCH_DOWN);
    expect(sql).toContain("drop function if exists public.catalog_search");
    expect(sql).not.toContain("policy_categories");
    expect(sql).toContain("grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role");
  });
});
