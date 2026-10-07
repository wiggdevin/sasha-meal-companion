import { beforeAll, describe, expect, it } from "vitest";
import { hasBranch, psql, resetCatalogFixtures } from "./helpers";

/** Inserts one 'off' fixture revision and returns its id. */
function fixtureRevision(sourceId: string, nutrients: Record<string, number | null>): string {
  psql(`
    insert into catalog_versions (source, version_label) values ('off', 'test-atwater')
      on conflict (source, version_label) do nothing;
    insert into catalog_foods (source, source_id) values ('off', '${sourceId}');
    insert into catalog_nutrients (code, name, unit, derivation) values
      ('protein','Protein','g','measured'), ('carbohydrate','Carbohydrate','g','measured'),
      ('fat_total','Total lipid (fat)','g','measured'), ('fiber_total','Fiber','g','measured'),
      ('energy_kcal','Energy','kcal','measured')
      on conflict (code) do nothing;
    insert into catalog_food_revisions
      (description, catalog_food_id, catalog_version_id, quality_class, content_hash)
    select '${sourceId}', f.id, v.id, 'analytical', 'h-${sourceId}'
      from catalog_foods f, catalog_versions v
     where f.source_id = '${sourceId}' and v.version_label = 'test-atwater';`);
  const id = psql(`select r.id from catalog_food_revisions r
                     join catalog_foods f on f.id = r.catalog_food_id
                    where f.source_id = '${sourceId}';`);
  for (const [code, amount] of Object.entries(nutrients)) {
    psql(`insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
            values (${id}, '${code}', ${amount === null ? "null" : amount});`);
  }
  return id;
}

describe.skipIf(!hasBranch)("catalog_atwater_kcal", () => {
  beforeAll(() => resetCatalogFixtures("test-atw-", "test-atwater"));

  it("computes 4P + 4 available carb + 9F and reports complete", () => {
    const id = fixtureRevision("test-atw-complete", {
      protein: 20, carbohydrate: 10, fiber_total: 2, fat_total: 5,
    });
    // 4*20 + 4*(10-2) + 9*5 = 80 + 32 + 45 = 157
    // psql runs with -F '|' (see helpers.ts), so two columns render as "157.0|t" — manual
    // `||` concatenation would instead force a boolean->text cast that yields "true", not "t".
    expect(psql(`select kcal, complete from catalog_atwater_kcal(${id});`)).toBe("157.0|t");
  });

  it("falls back to total carbohydrate when fiber is not reported", () => {
    const id = fixtureRevision("test-atw-nofiber", {
      protein: 20, carbohydrate: 10, fat_total: 5,
    });
    // 4*20 + 4*10 + 9*5 = 165
    expect(psql(`select kcal from catalog_atwater_kcal(${id});`)).toBe("165.0");
  });

  it("reports complete = false when any macro is missing", () => {
    const id = fixtureRevision("test-atw-incomplete", {
      protein: 20, carbohydrate: 10, fat_total: null,
    });
    expect(psql(`select complete from catalog_atwater_kcal(${id});`)).toBe("f");
  });

  it("supports the 10 % mismatch test the worker runs", () => {
    const id = fixtureRevision("test-atw-mismatch", {
      protein: 20, carbohydrate: 10, fiber_total: 2, fat_total: 5, energy_kcal: 300,
    });
    const mismatch = psql(`
      select abs(n.amount_per_100g - a.kcal) / n.amount_per_100g > 0.10
        from catalog_food_nutrients n, catalog_atwater_kcal(${id}) a
       where n.food_revision_id = ${id} and n.nutrient_code = 'energy_kcal';`);
    expect(mismatch).toBe("t");
    resetCatalogFixtures("test-atw-", "test-atwater");
  });

  it("revokes execute from anon — only authenticated and service_role may call it", () => {
    expect(
      psql(`select has_function_privilege('anon', 'catalog_atwater_kcal(bigint)', 'execute');`)
    ).toBe("f");
  });
});
