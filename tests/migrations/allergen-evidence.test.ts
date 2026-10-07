/**
 * Phase 13 §9 R2 (slice 2): the allergen evidence migration, read as text (the pattern of
 * tests/migrations/policy-categories.test.ts). The migration is applied to production by the
 * coordinator; CI's integration suite applies it to a fresh local database, where
 * tests/tenancy/table-matrix.test.ts and rls-lint check the two tables' grants and policies.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_KEYS } from "@/lib/policy/allergens";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261118090000_allergen_evidence.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261118090000_allergen_evidence.down.sql"));

describe("20261118090000_allergen_evidence", () => {
  it("is guarded: refuses a second run and a database without the legacy tag columns", () => {
    expect(UP).toMatch(/to_regclass\('public\.food_allergen_evidence'\) is not null/);
    expect(UP).toMatch(/raise exception '20261118090000_allergen_evidence: already applied'/);
    expect(UP).toMatch(/raise exception '20261118090000_allergen_evidence: allergen_tags columns are missing'/);
  });

  it("stores evidence per food revision and allergen, with label completeness", () => {
    expect(UP).toContain("primary key (food_key, allergen)");
    expect(UP).toMatch(/level in \('listed', 'not_listed', 'no_evidence'\)/);
    expect(UP).toContain("label_complete boolean not null default false");
    // not_listed only ever comes from a complete list.
    expect(UP).toContain("check (level <> 'not_listed' or label_complete)");
  });

  it("lets a user read catalog evidence and their own, and write neither table's other rows", () => {
    expect(UP).toMatch(/food_allergen_evidence_read on food_allergen_evidence for select to authenticated\s+using \(user_id is null or user_id = \(select auth\.uid\(\)\)\)/);
    expect(UP).toContain("grant select on table food_allergen_evidence to authenticated;");
    expect(UP).not.toMatch(/grant (insert|update|delete)[^;]*food_allergen_evidence to authenticated/);
    expect(UP).toMatch(/user_allergen_checks_rw on user_allergen_checks for all to authenticated\s+using \(user_id = \(select auth\.uid\(\)\)\) with check \(user_id = \(select auth\.uid\(\)\)\)/);
    expect(UP).toContain("grant select, insert, delete on table user_allergen_checks to authenticated;");
    for (const table of ["food_allergen_evidence", "user_allergen_checks"]) {
      expect(UP).toContain(`alter table ${table} force row level security;`);
      expect(UP).toContain(`revoke all on table ${table} from public, anon, authenticated;`);
    }
  });

  it("converts legacy empty tags and client-created custom foods to no_evidence, never not_listed (R2)", () => {
    expect(UP).toMatch(/then 'listed' else 'no_evidence' end/);
    expect(UP).not.toMatch(/'not_listed',\s*(true|false),\s*'legacy'/);
    expect(UP).toMatch(/from user_foods uf cross join _p13_allergen_key k\s+where uf\.deleted_at is null/);
    expect(UP).toMatch(/where exists \(select 1 from catalog_ingredients ci where ci\.food_revision_id = r\.id\)/);
  });

  it("recovers a legacy wheat declaration stored only as 'gluten' by the old OFF mapping, for " +
    "both user foods and catalog revisions, never the reverse", () => {
    const clause = "k.allergen = 'wheat' and lower(btrim(t)) = 'gluten'";
    const occurrences = UP.split(clause).length - 1;
    expect(occurrences).toBe(2); // once for user_foods, once for catalog_food_revisions
    expect(UP).not.toContain("k.allergen = 'gluten' and lower(btrim(t)) = 'wheat'");
  });

  it("finding #9: recovers a legacy crustacean declaration for both user foods and catalog " +
    "revisions, never a mollusc-only spelling", () => {
    const occurrences = UP.split("k.allergen = 'crustacean' and lower(btrim(t)) in").length - 1;
    expect(occurrences).toBe(2);
    for (const word of ["clam", "mussel", "oyster", "scallop", "squid", "octopus"]) {
      expect(UP).not.toContain(`'${word}'`);
    }
  });

  it("review round 2 (sol/BLOCK): maps legacy 'barley' and 'rye' tags straight to gluten, the " +
    "same two off-map.ts's GLUTEN regex and TAG_ALIASES already recognize at runtime (neither " +
    "is a wheat species) — without a row here neither ever matched the gluten key below, so an " +
    "explicit legacy 'barley'/'rye' declaration backfilled as no_evidence and a later label " +
    "check could allow a food that names a gluten source outright", () => {
    expect(UP).toContain("('barley', 'gluten')");
    expect(UP).toContain("('rye', 'gluten')");
  });

  it("review round 2 (sol/FIX): maps every OTHER spelling allergenKey (lib/policy/allergens.ts) " +
    "already resolves for tree-nut and crustacean to the SAME canonical key here, so the legacy " +
    "backfill never writes a raw, un-normalized row (e.g. 'tree nut') beside the canonical " +
    "'tree-nut'/'crustacean' row for the same food_key — two rows for what allergenKey reads as " +
    "one key, left to whichever a plain read happens to see last (lib/server/allergen-" +
    "evidence.ts fetchEvidenceRows)", () => {
    expect(UP).toContain("('tree nut', 'tree-nut')");
    expect(UP).toContain("('tree_nut', 'tree-nut')");
    expect(UP).toContain("('crustacean shellfish', 'crustacean')");
  });

  it("sol finding (BLOCK): maps legacy tree-nut species tags straight to the tree-nut key, the " +
    "same species off-map.ts's TAG_ALIASES already recognizes at runtime, so a legacy 'almonds' " +
    "tag backfills as listed for tree-nut, not no_evidence", () => {
    for (const species of [
      "almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan", "pecans",
      "pistachio", "pistachios", "hazelnut", "hazelnuts", "filbert", "filberts", "macadamia",
      "macadamias", "macadamia-nuts", "brazil-nut", "brazil-nuts", "pine-nut", "pine-nuts",
    ]) {
      expect(UP).toContain(`('${species}', 'tree-nut')`);
    }
  });

  it("sol finding (BLOCK): maps legacy wheat-species tags straight to the wheat key, and also " +
    "recovers the gluten key for them (a spelt/kamut/triticale/einkorn/farro declaration is a " +
    "gluten declaration too), the same multi-mapping off-map.ts's TAG_ALIASES already applies at " +
    "runtime", () => {
    for (const species of ["spelt", "kamut", "triticale", "einkorn", "farro"]) {
      expect(UP).toContain(`('${species}', 'wheat')`);
    }
    const clause = "k.allergen = 'gluten' and lower(btrim(t)) in";
    const occurrences = UP.split(clause).length - 1;
    expect(occurrences).toBe(2); // once for user_foods, once for catalog_food_revisions
    for (const species of ["spelt", "kamut", "triticale", "einkorn", "farro"]) {
      expect(UP.match(new RegExp(`'${species}'`, "g"))?.length).toBe(3); // alias row + 2 recoveries
    }
  });

  it("finding #1 (FIX): food_allergen_evidence is monotonic — an update may only move `level` up " +
    "listed > not_listed > no_evidence, never down, so a stale concurrent writer cannot undo a " +
    "stronger stored value", () => {
    expect(UP).toMatch(
      /select case v_level when 'listed' then 2 when 'not_listed' then 1 else 0 end/);
    expect(UP).toMatch(
      /if public\._p13_allergen_evidence_rank\(new\.level\) < public\._p13_allergen_evidence_rank\(old\.level\) then/);
    expect(UP).toContain("new.level := old.level;");
    expect(UP).toContain("new.label_complete := old.label_complete;");
    expect(UP).toContain("create trigger food_allergen_evidence_monotonic\n" +
      "  before update on food_allergen_evidence");
    // Governs food_allergen_evidence alone — user_allergen_checks (the explicit user-check table)
    // carries no such trigger, and a new revision is always a fresh INSERT, never routed through it.
    expect(UP).not.toMatch(/create trigger \w+\s+before (insert|update) on user_allergen_checks[\s\S]*monotonic/);
    expect(DOWN).toContain("drop function if exists public._p13_monotonic_allergen_evidence();");
    expect(DOWN).toContain("drop function if exists public._p13_allergen_evidence_rank(text);");
  });

  it("converts for exactly the allergen keys the policy stores", () => {
    const keys = [...UP.matchAll(/\('([a-z-]+)'\)[,;]/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...EVIDENCE_KEYS].sort());
  });

  it("validates a check's food_key against the real catalog revision or the caller's own user " +
    "food at that exact revision, not just its format (sol finding: a preinsertable future or " +
    "another account's key)", () => {
    expect(UP).toContain("create trigger user_allergen_checks_validate_food_key\n" +
      "  before insert or update on user_allergen_checks");
    expect(UP).toMatch(/security definer set search_path = ''/);
    expect(UP).toMatch(/select 1 from public\.catalog_food_revisions where id = v_catalog_id/);
    expect(UP).toMatch(
      /select 1 from public\.user_foods\s+where id = v_user_food_id and rev = v_rev and user_id = new\.user_id/,
    );
    expect(DOWN).toContain(
      "drop function if exists public._validate_allergen_check_food_key();",
    );
  });

  it("down drops both tables and the helper tables", () => {
    for (const table of ["user_allergen_checks", "food_allergen_evidence", "_p13_allergen_alias",
      "_p13_allergen_key"]) {
      expect(DOWN).toContain(`drop table if exists ${table};`);
    }
  });
});
