/**
 * psql helpers and the shared catalog fixture for the branch-backed search tests.
 *
 * Lane F's import may not have run on the branch, so these tests bring their own
 * rows. `search_doc` is written by the worker in production; here the fixture
 * builds it with the same `catalog_search_doc()` function the migration defines.
 *
 * `seedCatalogFixture`/`dropCatalogFixture` take a caller-chosen `tag` used for both
 * the `catalog_versions.version_label` (`test-catalog-<tag>`) and the `catalog_foods.source_id`
 * prefix (`test-<tag>-<n>`), so two test files never collide over the same rows when
 * run in the same process (default vitest parallelism).
 */

import { execFileSync } from "node:child_process";

const DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";
export const HAS_DB = DB_URL.length > 0;

export function sql(statement: string): string {
  return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", statement], {
    encoding: "utf8",
  }).trim();
}

export function exec(statements: string): void {
  execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", statements], {
    encoding: "utf8",
  });
}

/** The `catalog_versions.version_label` a given fixture tag seeds under. */
export function fixtureVersion(tag: string): string {
  return `test-catalog-${tag}`;
}

/**
 * A token only this tag's rows carry, written into their `category` (weight C in
 * `catalog_search_doc`). A test prefixes its queries with it so the fixture rows win the lexical
 * feature over the thousands of real rows a loaded branch holds for "chicken" or "rice"; without
 * it the ten fixture rows never reach the 25-row cap on a branch that carries the real import.
 */
export function fixtureToken(tag: string): string {
  return `zq${tag}`;
}

/** The active revision ids this tag seeded, so a test can keep its assertions on its own rows. */
export function fixtureRevisionIds(tag: string): Set<number> {
  const out = sql(`
    select r.id from catalog_food_revisions r
    join catalog_versions v on v.id = r.catalog_version_id
    where v.version_label = '${fixtureVersion(tag)}'`);
  return new Set(out.split("\n").filter(Boolean).map(Number));
}

/**
 * Ten revisions across four quality classes, two prep states, one branded row.
 *
 * Source is "off" (OpenFoodFacts, Phase 3), not "fdc_sr_legacy": on a branch that already
 * carries a real catalog import (integration's reused p1-catalog branch), every fdc_* source
 * already has an active catalog_versions row — fdc_foundation/fdc_sr_legacy/fdc_fndds from the
 * real import, fdc_branded from tests/log/fixtures.ts's shared "test-1" row — and this insert
 * would otherwise collide with catalog_versions_one_active_per_source. "off" has no rows on
 * this branch and is not claimed by any other fixture, so it stays free for this file alone.
 */
export function seedCatalogFixture(tag: string): void {
  const version = fixtureVersion(tag);
  exec(`
    insert into catalog_versions (source, version_label, row_counts, is_active)
      values ('off', '${version}', '{"revisions":10}'::jsonb, true)
      on conflict (source, version_label) do update set is_active = true;

    insert into catalog_foods (source, source_id)
      select 'off', 'test-${tag}-' || g from generate_series(1, 10) g
      on conflict (source, source_id) do nothing;

    insert into catalog_food_revisions (
      catalog_food_id, catalog_version_id, description, brand, category, prep_state,
      quality_class, quality_flags, search_doc, content_hash, is_active)
    select
      cf.id,
      (select id from catalog_versions where version_label = '${version}'),
      d.description, d.brand, 'Test Foods ${fixtureToken(tag)}', d.prep_state, d.quality_class, d.flags,
      catalog_search_doc(d.description, d.brand, 'Test Foods ${fixtureToken(tag)}'),
      'hash-${tag}-' || d.n, true
    from (values
      (1,  'Chicken, breast, meat only, roasted',     null,        'roasted', 'analytical', '{}'::text[]),
      (2,  'Chicken, thigh, meat only, roasted',      null,        'roasted', 'analytical', '{}'::text[]),
      (3,  'Chicken, breast, meat and skin, fried',   null,        'fried',   'survey',     '{}'::text[]),
      (4,  'Rice, white, long-grain, cooked',         null,        'cooked',  'analytical', '{}'::text[]),
      (5,  'Rice, white, long-grain, raw',            null,        'raw',     'survey',     '{}'::text[]),
      (6,  'Sweet potato, cooked, baked in skin',     null,        'baked',   'analytical', '{}'::text[]),
      (7,  'Olive oil, extra virgin',                 'Kirkland',  null,      'label',      '{}'::text[]),
      (8,  'Olive oil, salad or cooking',              null,       null,      'analytical', '{}'::text[]),
      (9,  'Avocado, raw, California',                null,        'raw',     'analytical', '{energy_mismatch}'::text[]),
      (10, 'Avocado spread, homemade',                null,        null,      'crowd',      '{energy_mismatch}'::text[])
    ) as d(n, description, brand, prep_state, quality_class, flags)
    join catalog_foods cf on cf.source = 'off' and cf.source_id = 'test-${tag}-' || d.n
    on conflict (catalog_food_id, catalog_version_id) do nothing;
  `);
}

export function dropCatalogFixture(tag: string): void {
  const version = fixtureVersion(tag);
  exec(`
    delete from catalog_food_revisions r using catalog_versions v
      where v.id = r.catalog_version_id and v.version_label = '${version}';
    delete from catalog_foods where source = 'off' and source_id like 'test-${tag}-%';
    delete from catalog_versions where version_label = '${version}';
  `);
}
