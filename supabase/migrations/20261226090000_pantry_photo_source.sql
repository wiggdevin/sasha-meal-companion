-- Migration 7 (phase-18 W12, docs/specs/phase-18-open-world-foods.md §W12). Pantry rows written
-- from a confirmed photo draft are indistinguishable from a manually typed stock confirmation
-- today (shopping_pantry has no provenance column at all). Acceptance 2 needs every confirmed
-- photo item to carry `source: 'photo'`; every existing and future manual row keeps the default
-- so no backfill is needed and no existing writer (lib/shopping/repository.ts putPantry, called
-- from app/api/shopping/pantry) has to change its call shape to keep working.
--
-- RLS: shopping_pantry already has `shopping_pantry_owner` (migration 20261127090000) covering
-- select/insert/update/delete `using/with check (user_id = (select auth.uid()))`. A new column on
-- an existing RLS-protected table inherits that policy automatically — no policy change needed,
-- and the tenancy canary (tests/tenancy/table-ops.json + fixtures.ts) already has a
-- `shopping_pantry` builder that exercises this table's RLS; it covers the new column for free
-- since it inserts whatever columns the builder sets and does not special-case `source`.
alter table public.shopping_pantry
  add column source text not null default 'manual' check (source in ('manual', 'photo'));

comment on column public.shopping_pantry.source is
  'How this stock confirmation entered the pantry: manual (typed) or photo (W12 pantry-from-a-photo, confirm-first).';
