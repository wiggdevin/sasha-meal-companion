/**
 * Phase 18 W2a (spec §6 migration 2): the allergen evidence review migration, read as text (the
 * pattern of tests/migrations/allergen-evidence.test.ts). Its behaviour was proved on the local
 * stack inside a rolled-back transaction; production is applied by the owner, with a backup.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261212090000_allergen_evidence_review.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261212090000_allergen_evidence_review.down.sql"));

describe("20261212090000_allergen_evidence_review", () => {
  it("is guarded against a second run and a missing table", () => {
    expect(UP).toMatch(/raise exception '20261212090000_allergen_evidence_review: already applied'/);
    expect(UP).toMatch(/raise exception '20261212090000_allergen_evidence_review: food_allergen_evidence is missing'/);
  });

  it("adds the two nullable review columns, set together or not at all", () => {
    expect(UP).toContain("add column reviewed_at timestamptz null");
    expect(UP).toContain("add column reviewed_by text null");
    expect(UP).toContain("check ((reviewed_at is null) = (reviewed_by is null))");
  });

  it("deletes and rewrites no row", () => {
    expect(UP).not.toMatch(/\b(delete from|update public\.food_allergen_evidence|update food_allergen_evidence|insert into)\b/i);
  });

  it("lowers a hold only through a logged review to deterministic evidence", () => {
    expect(UP).toMatch(/old\.level = 'listed' and old\.source = 'jev'/);
    expect(UP).toMatch(/new\.source in \('label', 'ingredients', 'legacy'\)/);
    expect(UP).toMatch(/new\.level in \('listed', 'not_listed'\)/);
    expect(UP).toMatch(/new\.reviewed_at is distinct from old\.reviewed_at/);
  });

  it("keeps a hold on ANY non-review update, including the old writer's equal-rank relabel (r2)", () => {
    // origin/main's warm writer re-upserts a held row as listed / source 'ingredients' with no
    // review fields. That is not a review, so the held branch must restore everything before the
    // rank check is ever reached.
    const body = UP.slice(UP.indexOf("create or replace function public._p13_monotonic_allergen_evidence()"));
    expect(body).toMatch(/v_held := old\.level = 'listed' and old\.source = 'jev';/);
    expect(body).toMatch(/v_review := v_held/);
    const held = body.slice(body.indexOf("if v_held then"), body.indexOf("end if;", body.indexOf("if v_held then")));
    for (const column of ["level", "label_complete", "source", "reviewed_at", "reviewed_by"]) {
      expect(held).toContain(`new.${column} := old.${column};`);
    }
    expect(held).toContain("return new;");
    expect(body.indexOf("if v_review then")).toBeLessThan(body.indexOf("if v_held then"));
    expect(body.indexOf("if v_held then")).toBeLessThan(body.indexOf("_p13_allergen_evidence_rank(new.level)"));
    expect(body).toMatch(/new\.reviewed_by is not null/);
  });

  it("a coerced downgrade also restores the row's source, so a hold keeps source 'jev'", () => {
    const coerce = UP.slice(UP.indexOf("if public._p13_allergen_evidence_rank(new.level)"));
    expect(coerce).toMatch(/new\.level := old\.level;/);
    expect(coerce).toMatch(/new\.source := old\.source;/);
  });

  it("the down file restores the Phase 13 trigger body and drops the columns", () => {
    expect(DOWN).toContain("create or replace function public._p13_monotonic_allergen_evidence()");
    expect(DOWN).not.toContain("new.source := old.source");
    expect(DOWN).toContain("drop column if exists reviewed_by");
    expect(DOWN).toContain("drop column if exists reviewed_at");
  });

  it("refuses to delete a held row, except through the account cascade, and refuses truncate", () => {
    expect(UP).toMatch(/before delete on public\.food_allergen_evidence/);
    expect(UP).toMatch(/if old\.level = 'listed' and old\.source = 'jev' then/);
    expect(UP).toMatch(/not exists \(select 1 from auth\.users u where u\.id = old\.user_id\)/);
    expect(UP).toMatch(/before truncate on public\.food_allergen_evidence/);
    expect(DOWN).toContain("drop trigger if exists food_allergen_evidence_hold_delete");
    expect(DOWN).toContain("drop trigger if exists food_allergen_evidence_no_truncate");
  });
});
