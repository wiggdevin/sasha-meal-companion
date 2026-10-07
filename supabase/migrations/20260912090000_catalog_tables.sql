-- Phase 1, Lane F. Finishes the Phase 0 catalog shell (20260911000100_catalog_shell.sql):
-- the search helper and indexes §4.1 ranks on, the invariants activation rests on, and the
-- staging schema the import worker loads into. Every statement guards, so re-applying is a no-op.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- Phase 0 ships prep_state; a checkout without it gets it here. The vocabulary is contracts §3's
-- frozen PrepState union exactly — not architecture §3.1's list, which carries 'canned'/'dried'
-- (not in PrepState: a stored value the API's TS type could not represent) and is missing
-- 'baked'/'unknown' (in PrepState but never storable). Lane G's Open question 2 names this
-- mismatch; this is its resolution, made without a contract change because contracts' union is
-- the narrower, already-frozen one — the DDL moves to match it, not the reverse.
alter table catalog_food_revisions add column if not exists prep_state text;
alter table catalog_food_revisions drop constraint if exists catalog_food_revisions_prep_state_check;
alter table catalog_food_revisions add constraint catalog_food_revisions_prep_state_check
  check (prep_state in ('raw','cooked','boiled','roasted','fried','grilled','baked','unknown'));

-- search_doc stays the shell's plain tsvector column — not a generated column. The import worker
-- writes search_doc = catalog_search_doc(description, brand, category) on every import. The
-- immutable declaration below is deliberate: the dictionary is fixed for the life of the
-- database, and a reimport already rewrites every search_doc, so there is no update path this
-- immutability claim could break.
create or replace function catalog_search_doc(p_description text, p_brand text, p_category text)
returns tsvector language sql immutable as $$
  select setweight(to_tsvector('english', public.unaccent(coalesce(p_description,''))), 'A')
      || setweight(to_tsvector('english', public.unaccent(coalesce(p_brand,''))), 'B')
      || setweight(to_tsvector('english', public.unaccent(coalesce(p_category,''))), 'C'); $$;
create index if not exists catalog_food_revisions_fts on catalog_food_revisions using gin (search_doc);

-- §4.1 measures similarity(description, q); the mapper and branded queries also want the brand
-- in the trigram document, so both indexes exist and the planner picks per predicate.
create index if not exists catalog_food_revisions_trgm
  on catalog_food_revisions using gin (description gin_trgm_ops);
create index if not exists catalog_food_revisions_trgm_brand
  on catalog_food_revisions using gin ((description || ' ' || coalesce(brand, '')) gin_trgm_ops);

-- The two invariants the design rests on.
create unique index if not exists catalog_food_revisions_one_active
  on catalog_food_revisions (catalog_food_id) where is_active;
create unique index if not exists catalog_versions_one_active_per_source
  on catalog_versions (source) where is_active;

-- Join support for the import and for §4.1's nutrient and portion reads.
create index if not exists catalog_food_revisions_version
  on catalog_food_revisions (catalog_version_id);
create index if not exists catalog_food_nutrients_code
  on catalog_food_nutrients (nutrient_code);
create index if not exists catalog_portions_revision
  on catalog_portions (food_revision_id, seq);

-- The import worker's landing zone. Service role only; no user and no route ever reads it.
create schema if not exists catalog_staging;
revoke all on schema catalog_staging from public;
