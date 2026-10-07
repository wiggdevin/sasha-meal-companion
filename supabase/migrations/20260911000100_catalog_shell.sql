-- Phase 0: architecture v2.1 §3.1 catalog DDL. Shipped empty so user foreign keys resolve.
-- Phase 1's import worker fills it. Do not add rows here.
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists pgcrypto;

create table catalog_versions (id bigserial primary key, source text not null check (source
    in ('fdc_foundation','fdc_sr_legacy','fdc_fndds','fdc_branded','off')),
  version_label text not null, imported_at timestamptz not null default now(),
  row_counts jsonb not null default '{}'::jsonb, is_active boolean not null default false,
  unique (source, version_label));
create table catalog_foods (id bigserial primary key, source text not null, source_id text not null,
  first_seen_at timestamptz not null default now(), unique (source, source_id));
create table catalog_food_revisions (id bigserial primary key, description text not null, brand text,
  catalog_food_id bigint not null references catalog_foods(id), category text,
  catalog_version_id bigint not null references catalog_versions(id),
  prep_state text check (prep_state in ('raw','cooked','boiled','roasted','fried','grilled',
    'canned','dried')),
  quality_class text not null check (quality_class in ('analytical','survey','label','crowd')),
  quality_flags text[] not null default '{}', search_doc tsvector, content_hash text not null,
  valid_from timestamptz not null default now(), valid_to timestamptz,
  is_active boolean not null default false, unique (catalog_food_id, catalog_version_id));
create unique index catalog_food_revisions_one_active
  on catalog_food_revisions (catalog_food_id) where is_active;
create index catalog_food_revisions_fts on catalog_food_revisions using gin (search_doc);
create index catalog_food_revisions_trgm on catalog_food_revisions using gin (description gin_trgm_ops);
create table catalog_nutrients (code text primary key, fdc_nutrient_id integer, name text not null,
  unit text not null, nutrient_group text,
  derivation text not null check (derivation in ('measured','calculated','label')));
create table catalog_food_nutrients (nutrient_code text not null references catalog_nutrients(code),
  food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
  amount_per_100g numeric,        -- null = not measured; 0 = measured zero
  primary key (food_revision_id, nutrient_code));
create table catalog_barcodes (gtin14 char(14) not null check (gtin14 ~ '^[0-9]{14}$'),
  catalog_food_id bigint not null references catalog_foods(id), source text not null,
  published_at timestamptz, primary key (gtin14, catalog_food_id, source));

-- §3.1 prose, same shape, keyed to food_revision_id with on delete cascade.
create table catalog_portions (id bigserial primary key,
  food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
  description text, gram_weight numeric not null check (gram_weight > 0), seq integer not null,
  is_default boolean not null default false);
create table catalog_ingredients (
  food_revision_id bigint not null references catalog_food_revisions(id) on delete cascade,
  seq integer not null, name text not null, allergen_tags text[] not null default '{}',
  raw_text text, primary key (food_revision_id, seq));
create table catalog_dri (id bigserial primary key,
  nutrient_code text not null references catalog_nutrients(code), authority text not null,
  ref_type text not null check (ref_type in ('RDA','AI','UL','EAR')), sex text,
  age_min numeric, age_max numeric, life_stage text, value numeric not null, unit text not null,
  effective_date date);
