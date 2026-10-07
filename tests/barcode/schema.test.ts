import { describe, expect, it } from "vitest";
import { hasBranch, psql, psqlExpectError } from "@/tests/catalog/helpers";

const DRAFT = JSON.stringify({
  description: "Apple & blueberry pouch", brand: "Ella''s Kitchen", qualityClass: "crowd",
  per100g: { energy_kcal: 60, protein: 0.4, carbohydrate: 13.5, fat_total: 0.2, iron: null },
  portions: [{ description: "1 pouch (90 g)", gramWeight: 90 }],
  ingredients: [{ seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"] }],
  ingredientsText: "Apple juice concentrate, blueberry puree", qualityFlags: ["energy_mismatch"],
  sourceId: "04006381333931", publishedAt: "2026-09-19T12:00:00Z",
});

const GTIN = "04006381333931";

function seedUser(): string {
  return psql(`select id from auth.users order by created_at limit 1;`);
}

function clean(): void {
  psql(`create temporary table fixture_barcode_versions as
          select distinct catalog_version_id as id from catalog_food_revisions
          where catalog_food_id in (select id from catalog_foods where source = 'off' and source_id = '${GTIN}');
        delete from catalog_barcode_lookups where gtin14 = '${GTIN}';
        delete from food_refs where catalog_food_id in (select id from catalog_foods where source_id = '${GTIN}');
        delete from catalog_barcodes where gtin14 = '${GTIN}';
        delete from catalog_food_revisions where catalog_food_id in (select id from catalog_foods where source_id = '${GTIN}');
        delete from catalog_foods where source_id = '${GTIN}';
        delete from catalog_versions where id in (select id from fixture_barcode_versions)
          and not exists (select 1 from catalog_food_revisions r where r.catalog_version_id = catalog_versions.id);`);
}

describe.skipIf(!hasBranch)("phase 3 barcode cache", () => {
  it("creates catalog_barcode_lookups with the spec's constraints and RLS enabled", () => {
    expect(psql(`select count(*) from information_schema.columns
                  where table_name = 'catalog_barcode_lookups';`)).toBe("7");
    // 20261008090000_catalog_rls_lint.sql closed the advisor's rls_disabled_in_public ERROR:
    // RLS is on and forced here, same shape as the nine catalog_grants.sql tables.
    expect(psql(`select relrowsecurity from pg_class where relname = 'catalog_barcode_lookups';`))
      .toBe("t");
    expect(psql(`select indexname from pg_indexes
                  where tablename = 'catalog_barcode_lookups' and indexname like '%stale';`))
      .toBe("catalog_barcode_lookups_stale");
    expect(psqlExpectError(
      `insert into catalog_barcode_lookups (gtin14, status) values ('0400638133393x', 'miss');`
    )).toContain("violates check constraint");
  });

  it("lets authenticated read the ledger and write nothing", () => {
    expect(psql(`set local role authenticated;
                 select count(*) from catalog_barcode_lookups;`)).toContain("SET");
    expect(psqlExpectError(`set local role authenticated;
      insert into catalog_barcode_lookups (gtin14, status) values ('${GTIN}', 'miss');`))
      .toContain("permission denied for table catalog_barcode_lookups");
    expect(psqlExpectError(`set local role authenticated;
      insert into catalog_barcodes (gtin14, catalog_food_id, source) values ('${GTIN}', 1, 'off');`))
      .toContain("permission denied for table catalog_barcodes");
  });

  it("writes version, food, revision, children, barcode and food_ref in one call", () => {
    clean();
    const userId = seedUser();
    const out = psql(
      `select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${DRAFT}'::jsonb);`);
    expect(out).toContain('"version_label"');
    expect(psql(`select count(*) from catalog_foods where source = 'off' and source_id = '${GTIN}';`)).toBe("1");
    expect(psql(`select count(*) from catalog_food_revisions r join catalog_foods f
                   on f.id = r.catalog_food_id where f.source_id = '${GTIN}' and r.is_active;`)).toBe("1");
    expect(psql(`select count(*) from catalog_barcodes where gtin14 = '${GTIN}';`)).toBe("1");
    expect(psql(`select count(*) from catalog_portions p join catalog_food_revisions r
                   on r.id = p.food_revision_id join catalog_foods f on f.id = r.catalog_food_id
                  where f.source_id = '${GTIN}' and p.is_default;`)).toBe("1");
    expect(psql(`select count(*) from food_refs fr join catalog_foods f on f.id = fr.catalog_food_id
                  where f.source_id = '${GTIN}';`)).toBe("1");
    expect(psql(`select count(*) from catalog_versions where is_active and source = 'off';`)).toBe("0");
    clean();
  });

  it("rolls the whole write back when one child row is bad", () => {
    clean();
    const userId = seedUser();
    const bad = DRAFT.replace('"gramWeight":90', '"gramWeight":"not-a-number"');
    psqlExpectError(
      `select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${bad}'::jsonb);`);
    expect(psql(`select count(*) from catalog_foods where source_id = '${GTIN}';`)).toBe("0");
    clean();
  });

  it("refuses a bad source, a bad gtin and a call from authenticated", () => {
    const userId = seedUser();
    expect(psqlExpectError(
      `select catalog_write_provider_revision('${userId}'::uuid, 'off', 'abc', '${DRAFT}'::jsonb);`))
      .toContain("bad_gtin");
    expect(psqlExpectError(
      `select catalog_write_provider_revision('${userId}'::uuid, 'oops', '${GTIN}', '${DRAFT}'::jsonb);`))
      .toContain("bad_source");
    expect(psqlExpectError(`set local role authenticated;
      select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${DRAFT}'::jsonb);`))
      .toContain("permission denied for function catalog_write_provider_revision");
    clean();
  });
});
