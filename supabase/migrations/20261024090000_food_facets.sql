-- Phase C C1a: reusable Jev judgments for an exact food identity, input and rubric revision.
create table food_facets (
  food_key text not null,
  input_hash bytea not null,
  facet text not null,
  rubric_version integer not null,
  p numeric(4,3) not null constraint food_facets_p_range check (p >= 0 and p <= 1),
  model text not null,
  judged_at timestamptz not null default now(),
  user_id uuid null,
  primary key (food_key, input_hash, facet, rubric_version)
);

alter table food_facets enable row level security;
alter table food_facets force row level security;

create policy food_facets_service_role on food_facets for all to service_role
  using (true) with check (true);

revoke all on table food_facets from public, anon, authenticated;
grant all on table food_facets to service_role;

-- Down: supabase/migrations/down/20261024090000_food_facets.down.sql removes this cache table.
