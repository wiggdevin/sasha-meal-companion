import { describe, expect, it } from "vitest";
import { hasBranch, psql, psqlExpectError, resetCatalogFixtures } from "./helpers";

const TABLES = [
  "catalog_versions", "catalog_foods", "catalog_food_revisions", "catalog_nutrients",
  "catalog_food_nutrients", "catalog_barcodes", "catalog_portions", "catalog_ingredients",
  "catalog_dri",
  // 20261008090000_catalog_rls_lint.sql closed the advisor's rls_disabled_in_public ERROR on
  // these two (docs/decisions/2026-09-12-wave4-rulings.md ruling 13).
  "catalog_synonyms", "catalog_barcode_lookups",
  // Phase 18 W4: the documented FNDDS recipe inputs (20261214100000_catalog_food_inputs.sql).
  "catalog_food_inputs",
];

describe.skipIf(!hasBranch)("catalog grants", () => {
  it("has row level security on every catalog table", () => {
    const off = psql(`select coalesce(string_agg(relname, ','), '') from pg_class
                        where relname = any (array[${TABLES.map((t) => `'${t}'`).join(",")}])
                          and not relrowsecurity;`);
    expect(off).toBe("");
  });

  it("gives authenticated exactly one select policy per table and no write policy", () => {
    expect(
      psql(`select count(*) from pg_policies where schemaname = 'public'
              and tablename like 'catalog\\_%' and cmd = 'SELECT';`)
    ).toBe(String(TABLES.length));
    expect(
      psql(`select count(*) from pg_policies where schemaname = 'public'
              and tablename like 'catalog\\_%' and cmd <> 'SELECT';`)
    ).toBe("0");
  });

  it("lets authenticated read the catalog", () => {
    resetCatalogFixtures("test-grants", "test-grants");
    psql(`insert into catalog_versions (source, version_label) values ('off', 'test-grants');`);
    // psql -At still emits the "SET" command tag for the role switch ahead of the select's
    // own output, even with headers/row counts off — so the combined result is two lines.
    expect(
      psql(`set local role authenticated;
            select count(*) from catalog_versions where version_label = 'test-grants';`)
    ).toBe("SET\n1");
  });

  it("refuses every write from authenticated", () => {
    expect(
      psqlExpectError(`set local role authenticated;
        insert into catalog_foods (source, source_id) values ('off', 'test-grants-write');`)
    ).toContain("permission denied for table catalog_foods");
    expect(
      psqlExpectError(`set local role authenticated;
        update catalog_versions set is_active = true where version_label = 'test-grants';`)
    ).toContain("permission denied for table catalog_versions");
    expect(
      psqlExpectError(`set local role authenticated;
        delete from catalog_versions where version_label = 'test-grants';`)
    ).toContain("permission denied for table catalog_versions");
  });

  it("gives anon nothing at all", () => {
    expect(
      psqlExpectError(`set local role anon; select count(*) from catalog_foods;`)
    ).toContain("permission denied for table catalog_foods");
    resetCatalogFixtures("test-grants", "test-grants");
  });
});
