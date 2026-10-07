import { beforeEach, describe, expect, it } from "vitest";
import { hasBranch, psql, psqlExpectError, resetCatalogFixtures } from "./helpers";

/** One 'off' food with a revision in each of two labelled versions. */
function twoVersionFixture(): void {
  psql(`
    insert into catalog_versions (source, version_label) values ('off', 'test-v1'), ('off', 'test-v2');
    insert into catalog_foods (source, source_id) values ('off', 'test-act-1');
    insert into catalog_food_revisions
      (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
    select 'Sirloin steak, broiled (v1)', f.id, v.id, 'analytical', 'h-v1', false
      from catalog_foods f, catalog_versions v
     where f.source_id = 'test-act-1' and v.version_label = 'test-v1';
    insert into catalog_food_revisions
      (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
    select 'Sirloin steak, broiled (v2)', f.id, v.id, 'analytical', 'h-v2', false
      from catalog_foods f, catalog_versions v
     where f.source_id = 'test-act-1' and v.version_label = 'test-v2';`);
}

describe.skipIf(!hasBranch)("catalog_activate_version", () => {
  beforeEach(() => {
    resetCatalogFixtures("test-act-", "test-v");
    twoVersionFixture();
  });

  it("leaves exactly one active revision per food", () => {
    psql(`select catalog_activate_version('test-v1');`);
    psql(`select catalog_activate_version('test-v2');`);
    expect(
      psql(`select count(*) from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("1");
    expect(
      psql(`select r.description from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("Sirloin steak, broiled (v2)");
  });

  it("stamps valid_to on the revision it replaces and keeps it for rollback", () => {
    psql(`select catalog_activate_version('test-v1');`);
    psql(`select catalog_activate_version('test-v2');`);
    expect(
      psql(`select count(*) from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and not r.is_active and r.valid_to is not null;`)
    ).toBe("1");
  });

  it("keeps catalog_food_id stable and food_refs intact across an activation", () => {
    psql(`select catalog_activate_version('test-v1');`);
    const foodId = psql(`select id from catalog_foods where source_id = 'test-act-1';`);
    psql(`insert into food_refs (kind, catalog_food_id) values ('catalog', ${foodId});`);
    psql(`select catalog_activate_version('test-v2');`);
    expect(psql(`select id from catalog_foods where source_id = 'test-act-1';`)).toBe(foodId);
    expect(psql(`select count(*) from food_refs where catalog_food_id = ${foodId};`)).toBe("1");
  });

  it("leaves exactly one active catalog_versions row per source", () => {
    psql(`select catalog_activate_version('test-v1');`);
    psql(`select catalog_activate_version('test-v2');`);
    expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
      .toBe("test-v2");
  });

  it("supports rolling back to an earlier label by activating it again", () => {
    psql(`select catalog_activate_version('test-v1');`);
    psql(`select catalog_activate_version('test-v2');`);
    psql(`select catalog_activate_version('test-v1');`);

    expect(
      psql(`select r.description from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("Sirloin steak, broiled (v1)");
    expect(
      psql(`select r.valid_to is null from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("t");
    expect(
      psql(`select r.valid_to is not null from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.description = 'Sirloin steak, broiled (v2)';`)
    ).toBe("t");
    expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
      .toBe("test-v1");
  });

  it("refuses a label that does not exist and changes nothing", () => {
    psql(`select catalog_activate_version('test-v1');`);
    const err = psqlExpectError(`select catalog_activate_version('test-missing');`);
    expect(err).toContain("no catalog_versions row for label");
    expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
      .toBe("test-v1");
  });

  it("keeps a food's previous revision active when the new version has no revision for it", () => {
    psql(`
      insert into catalog_foods (source, source_id) values ('off', 'test-act-2');
      insert into catalog_food_revisions
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
      select 'Oat bran, raw (v1 only)', f.id, v.id, 'analytical', 'h-b-v1', false
        from catalog_foods f, catalog_versions v
       where f.source_id = 'test-act-2' and v.version_label = 'test-v1';`);

    psql(`select catalog_activate_version('test-v1');`);
    psql(`select catalog_activate_version('test-v2');`);

    expect(
      psql(`select count(*) from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-2' and r.is_active;`)
    ).toBe("1");
    expect(
      psql(`select r.description from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-2' and r.is_active;`)
    ).toBe("Oat bran, raw (v1 only)");
    expect(
      psql(`select r.valid_to is null from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-2' and r.is_active;`)
    ).toBe("t");
    expect(
      psql(`select r.description from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("Sirloin steak, broiled (v2)");
  });

  it("refuses a label whose versions carry no revisions and changes nothing", () => {
    psql(`insert into catalog_versions (source, version_label) values ('off', 'test-v3');`);
    psql(`select catalog_activate_version('test-v1');`);

    const err = psqlExpectError(`select catalog_activate_version('test-v3');`);
    expect(err).toContain("no catalog_food_revisions for label");

    expect(psql(`select version_label from catalog_versions where source = 'off' and is_active;`))
      .toBe("test-v1");
    expect(
      psql(`select count(*) from catalog_food_revisions r
              join catalog_foods f on f.id = r.catalog_food_id
             where f.source_id = 'test-act-1' and r.is_active;`)
    ).toBe("1");
  });

  it("is execute-revoked from authenticated", () => {
    const err = psqlExpectError(
      `set local role authenticated; select catalog_activate_version('test-v1');`
    );
    expect(err).toContain("permission denied for function catalog_activate_version");
  });
});
