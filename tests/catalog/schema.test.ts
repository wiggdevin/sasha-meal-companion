import { describe, expect, it } from "vitest";
import { hasBranch, psql, psqlExpectError, resetCatalogFixtures } from "./helpers";

describe.skipIf(!hasBranch)("catalog schema", () => {
  it("provides an immutable catalog_search_doc helper", () => {
    expect(
      psql(`select provolatile from pg_proc
              where proname = 'catalog_search_doc' and pronamespace = 'public'::regnamespace;`)
    ).toBe("i");
  });

  it("computes search_doc from description, brand and category via catalog_search_doc", () => {
    resetCatalogFixtures("test-schema", "test-schema");
    psql(`
      insert into catalog_versions (source, version_label) values ('off', 'test-schema');
      insert into catalog_foods (source, source_id) values ('off', 'test-schema-1');
      insert into catalog_food_revisions
        (description, brand, category, catalog_food_id, catalog_version_id, quality_class, content_hash)
      select 'Chicken thigh, roasted', 'Bell and Evans', 'Poultry Products', f.id, v.id, 'analytical', 'h1'
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-schema-1' and v.version_label = 'test-schema';
      update catalog_food_revisions set search_doc = catalog_search_doc(description, brand, category)
       where content_hash = 'h1';`);
    const doc = psql(`select search_doc::text from catalog_food_revisions where content_hash = 'h1';`);
    expect(doc).toContain("chicken");
    expect(doc).toContain("evan");
    expect(doc).toContain("poultri");
    resetCatalogFixtures("test-schema", "test-schema");
  });

  it("folds accents in the search doc", () => {
    const doc = psql(`select catalog_search_doc('Crème fraîche', null, null)::text;`);
    expect(doc).toContain("creme");
    expect(doc).toContain("fraich");
  });

  it("restricts prep_state to the PrepState vocabulary", () => {
    resetCatalogFixtures("test-schema", "test-schema");
    psql(`
      insert into catalog_versions (source, version_label) values ('off', 'test-schema');
      insert into catalog_foods (source, source_id) values ('off', 'test-schema-2');`);
    psqlExpectError(`
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash, prep_state)
      select 'Salmon, canned', f.id, v.id, 'analytical', 'h2', 'canned'
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-schema-2' and v.version_label = 'test-schema';`);
    psql(`
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash, prep_state)
      select 'Salmon, baked', f.id, v.id, 'analytical', 'h3', 'baked'
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-schema-2' and v.version_label = 'test-schema';`);
    resetCatalogFixtures("test-schema", "test-schema");
  });

  it("carries the indexes and staging schema the import needs", () => {
    const names = psql(`select indexname from pg_indexes
                         where schemaname = 'public' and tablename like 'catalog\\_%' order by 1;`);
    for (const idx of [
      "catalog_food_revisions_fts",
      "catalog_food_revisions_one_active",
      "catalog_food_revisions_trgm",
      "catalog_food_revisions_trgm_brand",
      "catalog_versions_one_active_per_source",
    ]) {
      expect(names).toContain(idx);
    }
    expect(psql(`select count(*) from pg_namespace where nspname = 'catalog_staging';`)).toBe("1");
  });
});
