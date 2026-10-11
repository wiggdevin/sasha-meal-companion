/**
 * W059 (audit B007, loop010 F-055) on the real migrated schema (SUPABASE_TEST_DB_URL): a food the
 * barcode writer just stored is found by typing its name, a rescan (same day or a later day) leaves
 * one food and one hit, and the widened join still hides an inactive non-barcode version.
 * Migration 20261231190200 widens only the version join of `catalog_search`; the score expression
 * is pinned by tests/search/recall.test.ts and tests/search/score-parity.test.ts.
 */
import "../tenancy/local-only";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, asUser, dropAccounts } from "../helpers/world-db";

const UP = "supabase/migrations/20261231190200_catalog_search_barcode_versions.sql";
const DOWN = "supabase/migrations/down/20261231190200_catalog_search_barcode_versions.down.sql";
const SCORE = "round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep " +
  "+ 0.10 * f_prior + 0.05 * f_quality + 0.05 * f_eats, 6) as score";
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Letters only, so the name is one unique lexeme for the text search. */
const word = () => Array.from({ length: 10 }, () => String.fromCharCode(97 + randomInt(26))).join("");
const gtin = () => `98${String(randomInt(1e6)).padStart(6, "0")}${String(randomInt(1e6)).padStart(6, "0")}`;

const foods: string[] = [];
const versions: string[] = [];

function scan(user: string, source: "off" | "fdc_branded", code: string, name: string): string {
  const draft = JSON.stringify({ description: name, brand: "Wfiftynine Foods", per100g: { energy_kcal: 120 },
    policyCategories: [] });
  const out = JSON.parse(runSql(`select public.catalog_write_provider_revision('${user}', '${source}', '${code}',
    '${draft}'::jsonb)`)) as { catalog_food_id: number; revision_id: number };
  foods.push(String(out.catalog_food_id));
  return String(out.catalog_food_id);
}

/** The caller's own search, as the app makes it (authenticated, security invoker). */
const hits = (user: string, q: string) => asUser(user, `select coalesce(string_agg(
    catalog_food_id || ':' || revision_id || ':' || source, ',' order by score desc, revision_id), '')
  from public.catalog_search('${q}', null, null, 25)`).split("\n").filter((l) => /^\d|^$/.test(l)).at(-1) ?? "";

const count = (sql: string) => Number(runSql(sql));

describe("20261231190200 catalog_search barcode versions (static)", () => {
  it("widens only the version join and keeps the score expression", () => {
    const up = flat(readFileSync(UP, "utf8"));
    expect(up).toContain("join public.catalog_versions v on v.id = r.catalog_version_id " +
      "and (v.is_active or v.source in ('off', 'fdc_branded'))");
    expect(up).toContain(SCORE);
    expect(up).toContain("where r.is_active");
    expect(up).toContain("set local lock_timeout = '3s'");
  });

  it("down restores the active-only join with the same score", () => {
    const down = flat(readFileSync(DOWN, "utf8"));
    expect(down).toContain("join public.catalog_versions v on v.id = r.catalog_version_id and v.is_active");
    expect(down).not.toContain("v.source in");
    expect(down).toContain(SCORE);
  });
});

describe.skipIf(!HAS_DB)("catalog_search finds scanned foods (W059)", () => {
  afterAll(() => {
    if (foods.length) {
      const ids = [...new Set(foods)].join(",");
      runSql(`delete from public.food_refs where catalog_food_id in (${ids});
        delete from public.catalog_barcodes where catalog_food_id in (${ids});
        delete from public.catalog_ingredients where food_revision_id in
          (select id from public.catalog_food_revisions where catalog_food_id in (${ids}));
        delete from public.catalog_portions where food_revision_id in
          (select id from public.catalog_food_revisions where catalog_food_id in (${ids}));
        delete from public.catalog_food_nutrients where food_revision_id in
          (select id from public.catalog_food_revisions where catalog_food_id in (${ids}));
        delete from public.catalog_food_revisions where catalog_food_id in (${ids});
        delete from public.catalog_foods where id in (${ids});`);
    }
    if (versions.length) runSql(`delete from public.catalog_versions where id in (${versions.join(",")})`);
    dropAccounts();
  });

  it("scan, then search the name: one hit, the scanned food", () => {
    const a = account();
    const name = `Quill ${word()}`;
    const id = scan(a, "off", gtin(), name);
    const got = hits(a, name).split(",");
    expect(got[0]).toMatch(new RegExp(`^${id}:\\d+:off$`));
    expect(got.filter((h) => h.startsWith(`${id}:`))).toHaveLength(1);
  });

  it("finds an fdc_branded scan too", () => {
    const a = account();
    const name = `Branded ${word()}`;
    const id = scan(a, "fdc_branded", gtin(), name);
    expect(hits(a, name).split(",")[0]).toMatch(new RegExp(`^${id}:\\d+:fdc_branded$`));
  });

  it("a same-day rescan keeps one food, one active revision and one hit", () => {
    const a = account();
    const name = `Rescan ${word()}`;
    const code = gtin();
    const id = scan(a, "off", code, name);
    expect(scan(a, "off", code, name)).toBe(id);
    expect(count(`select count(*) from public.catalog_foods where source = 'off' and source_id = '${code}'`)).toBe(1);
    expect(count(`select count(*) from public.catalog_food_revisions where catalog_food_id = ${id} and is_active`))
      .toBe(1);
    expect(hits(a, name).split(",").filter((h) => h.startsWith(`${id}:`))).toHaveLength(1);
  });

  it("a later-day rescan stands the older revision down: still one hit, the new revision", () => {
    const a = account();
    const name = `Later ${word()}`;
    const code = gtin();
    const id = scan(a, "off", code, name);
    // Yesterday's scan: move the revision onto an older, never-activated barcode version.
    const older = runSql(`insert into public.catalog_versions (source, version_label, is_active)
      values ('off', 'test-w059-${word()}', false) returning id`).split("\n")[0];
    versions.push(older);
    runSql(`update public.catalog_food_revisions set catalog_version_id = ${older} where catalog_food_id = ${id}`);
    scan(a, "off", code, `${name} new`);
    const active = runSql(`select id from public.catalog_food_revisions where catalog_food_id = ${id} and is_active`);
    expect(active.split("\n")).toHaveLength(1);
    expect(count(`select count(*) from public.catalog_food_revisions where catalog_food_id = ${id}`)).toBe(2);
    const mine = hits(a, name).split(",").filter((h) => h.startsWith(`${id}:`));
    expect(mine).toEqual([`${id}:${active}:off`]);
  });

  it("still hides an inactive non-barcode version", () => {
    const a = account();
    const name = `Staged ${word()}`;
    const version = runSql(`insert into public.catalog_versions (source, version_label, is_active)
      values ('fdc_sr_legacy', 'test-w059-${word()}', false) returning id`).split("\n")[0];
    versions.push(version);
    const food = runSql(`insert into public.catalog_foods (source, source_id)
      values ('fdc_sr_legacy', 'test-w059-${word()}') returning id`).split("\n")[0];
    foods.push(food);
    runSql(`insert into public.catalog_food_revisions (catalog_food_id, catalog_version_id, description,
        quality_class, quality_flags, search_doc, content_hash, is_active)
      values (${food}, ${version}, '${name}', 'analytical', '{}', public.catalog_search_doc('${name}', null, null),
        'w059', true)`);
    expect(hits(a, name).split(",").filter((h) => h.startsWith(`${food}:`))).toHaveLength(0);
  });
});
