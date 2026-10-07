-- Phase 18 W4, step (a) of migration 3 (docs/specs/phase-18-open-world-foods.md §6 row 3, D5, D10).
-- A shared catalog table: the documented FNDDS recipe inputs of a mixed dish, one row per input of
-- the dish's catalog revision, in the FNDDS `seq_num` order.
--
--   food_revision_id       the dish's catalog revision (an `fdc_fndds` food); its inputs go with it
--   seq                    the FNDDS sequence number of the input in the dish's recipe
--   input_catalog_food_id  the input's catalog food: SR Legacy, Foundation, or an FNDDS food for a
--                          sub-recipe (read recursively by lib/server/mixed-dish-inputs.ts)
--   grams                  the input's gram weight in the documented recipe (> 0)
--   source                 'fndds' only. There is no 'jev' source: Jev never decomposes a dish.
--   estimated              true: a documented recipe is an estimate of what a dish contained,
--                          never the eater's own recipe
--
-- Written only by the owner-run import (scripts/import-fndds-inputs.ts, through service_role);
-- read-only to authenticated, nothing to anon, like every other catalog_* table
-- (20260912090200_catalog_grants.sql). The table is new and empty, so NOT NULL and the defaults
-- cost nothing. The foreign keys and checks are added NOT VALID here (no scan, and only a brief
-- SHARE ROW EXCLUSIVE lock on catalog_food_revisions and catalog_foods for the catalog update);
-- step (b), 20261214100100, validates them.
--
-- Apply order: 20261214100000, then 20261214100100, each file in its own transaction. Rollback:
-- supabase/migrations/down/20261214100000_catalog_food_inputs.down.sql (after the app deploy that
-- reads it is reverted).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.catalog_food_inputs') is not null then
    raise exception '20261214100000_catalog_food_inputs: already applied';
  end if;
end $$;

create table public.catalog_food_inputs (
  food_revision_id bigint not null,
  seq integer not null,
  input_catalog_food_id bigint not null,
  grams numeric not null,
  source text not null default 'fndds',
  estimated boolean not null default true,
  primary key (food_revision_id, seq)
);
comment on table public.catalog_food_inputs is
  'Phase 18 W4: documented FNDDS recipe inputs of a mixed dish revision. Import-written only (service_role).';

alter table public.catalog_food_inputs add constraint catalog_food_inputs_revision_fk
  foreign key (food_revision_id) references public.catalog_food_revisions(id) on delete cascade not valid;
alter table public.catalog_food_inputs add constraint catalog_food_inputs_input_fk
  foreign key (input_catalog_food_id) references public.catalog_foods(id) not valid;
alter table public.catalog_food_inputs add constraint catalog_food_inputs_grams
  check (grams > 0) not valid;
alter table public.catalog_food_inputs add constraint catalog_food_inputs_source
  check (source in ('fndds')) not valid;
alter table public.catalog_food_inputs add constraint catalog_food_inputs_seq
  check (seq > 0) not valid;

-- The foreign key's own index: a catalog_foods delete never scans this table.
create index catalog_food_inputs_input on public.catalog_food_inputs (input_catalog_food_id);

alter table public.catalog_food_inputs enable row level security;
alter table public.catalog_food_inputs force row level security;
create policy catalog_food_inputs_read on public.catalog_food_inputs for select to authenticated using (true);
revoke all on table public.catalog_food_inputs from public, anon, authenticated;
grant select on table public.catalog_food_inputs to authenticated;
grant all on table public.catalog_food_inputs to service_role;
