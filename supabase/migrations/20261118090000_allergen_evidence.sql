-- Phase 13 §5 and §9 R1/R2 (slice 2): allergen evidence per food revision and allergen, and the
-- user's own per-product label checks.
--
-- food_allergen_evidence: one row per (food revision, allergen key). `level` is listed /
-- not_listed / no_evidence; `label_complete` says whether a complete printed ingredient list was
-- behind it. A revision with no row for an allergen is no_evidence (lib/policy/allergens.ts), so
-- an empty legacy tag list can never read as "checked and clean" again.
--   food_key: 'catalog_revision:<id>' or 'user_food:<id>:<rev>' (lib/foods/facet-keys.ts).
--   user_id: null for catalog rows (shared catalog evidence); the owner for user-food rows.
-- Writes are service-role only (the warm path, lib/server/allergen-evidence.ts). Reads: a
-- signed-in user sees catalog rows and their own user-food rows.
--
-- user_allergen_checks: "I checked this exact product's label for <allergen>", per user. It is
-- the only way a non-major allergen (R1), or a product with no ingredient list, becomes allowed.
--
-- Legacy conversion (R2): every live user food, and every catalog revision that has ingredient
-- rows, gets a row per allergen key: `listed` where a legacy tag names it, otherwise
-- `no_evidence` with source 'legacy'. Client-created custom foods are therefore no_evidence.
-- Nothing is written as not_listed here: only the warm path's parse of a complete list may do that.
--
-- Guarded: refuses to run twice, and refuses when the columns it reads are missing.
do $$
begin
  if to_regclass('public.food_allergen_evidence') is not null
     or to_regclass('public.user_allergen_checks') is not null then
    raise exception '20261118090000_allergen_evidence: already applied';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'user_foods'
                    and column_name = 'allergen_tags')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'catalog_ingredients'
                    and column_name = 'allergen_tags') then
    raise exception '20261118090000_allergen_evidence: allergen_tags columns are missing';
  end if;
end $$;

create table food_allergen_evidence (
  food_key text not null
    constraint food_allergen_evidence_key check (food_key ~ '^(catalog_revision:[0-9]+|user_food:[0-9a-f-]{36}:[0-9]+)$'),
  allergen text not null
    constraint food_allergen_evidence_allergen check (allergen = lower(btrim(allergen)) and allergen <> ''),
  level text not null
    constraint food_allergen_evidence_level check (level in ('listed', 'not_listed', 'no_evidence')),
  label_complete boolean not null default false,
  source text not null
    constraint food_allergen_evidence_source check (source in ('ingredients', 'label', 'jev', 'legacy')),
  user_id uuid null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (food_key, allergen),
  -- not_listed is only ever read off a complete list.
  constraint food_allergen_evidence_not_listed_complete
    check (level <> 'not_listed' or label_complete),
  -- a user-food row always names its owner; a catalog row never does.
  constraint food_allergen_evidence_owner
    check ((food_key like 'user_food:%') = (user_id is not null))
);
create index food_allergen_evidence_user on food_allergen_evidence (user_id) where user_id is not null;

alter table food_allergen_evidence enable row level security;
alter table food_allergen_evidence force row level security;
create policy food_allergen_evidence_read on food_allergen_evidence for select to authenticated
  using (user_id is null or user_id = (select auth.uid()));
create policy food_allergen_evidence_service_role on food_allergen_evidence for all to service_role
  using (true) with check (true);
revoke all on table food_allergen_evidence from public, anon, authenticated;
grant select on table food_allergen_evidence to authenticated;
grant all on table food_allergen_evidence to service_role;

-- finding #1 (FIX): lib/server/allergen-evidence.ts recordAllergenEvidence's own pre-write read
-- narrows the ordinary case, but two genuinely concurrent warmers can still both read this row
-- before either writes: warmer A reads no_evidence, warmer B's upsert lands `listed`, and A's own
-- upsert — computed from what A saw, not from what is there NOW — then overwrites B's row with
-- `not_listed`. That ordering is invisible to the application; only the database can see it. This
-- makes the column itself monotonic: an UPDATE to an existing row (including the UPDATE half of an
-- upsert's ON CONFLICT, which is exactly the concurrent-warmer race above) may only move `level` UP
-- the listed > not_listed > no_evidence order, never down — a stale writer's downgrade is coerced
-- back to the row's own stronger value rather than applied, the same "a read failure degrades,
-- never upgrades" caution the module's header already documents, now enforced for a write the
-- application layer never even saw was stale.
--
-- Deliberately narrow: this governs food_allergen_evidence alone. An explicit user check
-- (user_allergen_checks, below) is a separate table this trigger never touches, so "the user
-- checked this exact product" still moves evidence however that flow decides. A new label revision
-- is a new food_key — always a fresh INSERT with no conflicting row — never routed through here.
create or replace function public._p13_allergen_evidence_rank(v_level text) returns int
language sql immutable set search_path = '' as $$
  select case v_level when 'listed' then 2 when 'not_listed' then 1 else 0 end
$$;

create or replace function public._p13_monotonic_allergen_evidence() returns trigger
language plpgsql set search_path = '' as $$
begin
  if public._p13_allergen_evidence_rank(new.level) < public._p13_allergen_evidence_rank(old.level) then
    new.level := old.level;
    new.label_complete := old.label_complete;
  end if;
  return new;
end $$;

create trigger food_allergen_evidence_monotonic
  before update on food_allergen_evidence
  for each row execute function public._p13_monotonic_allergen_evidence();

create table user_allergen_checks (
  user_id uuid not null references auth.users(id) on delete cascade,
  food_key text not null
    constraint user_allergen_checks_key check (food_key ~ '^(catalog_revision:[0-9]+|user_food:[0-9a-f-]{36}:[0-9]+)$'),
  allergen text not null
    constraint user_allergen_checks_allergen check (allergen = lower(btrim(allergen)) and allergen <> ''),
  checked_at timestamptz not null default now(),
  primary key (user_id, food_key, allergen)
);

alter table user_allergen_checks enable row level security;
alter table user_allergen_checks force row level security;
create policy user_allergen_checks_rw on user_allergen_checks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy user_allergen_checks_service_role on user_allergen_checks for all to service_role
  using (true) with check (true);
revoke all on table user_allergen_checks from public, anon, authenticated;
grant select, insert, delete on table user_allergen_checks to authenticated;
grant all on table user_allergen_checks to service_role;

-- sol finding (FIX): the CHECK above validates food_key's FORMAT only, never that it names a real
-- revision the caller could actually have read a label on. RLS lets any authenticated client
-- write its own user_id row through PostgREST directly, so a client could preinsert a
-- 'catalog_revision:<id that does not exist yet>' key; if that numeric id is later assigned to a
-- real, freshly-imported product, the pre-planted row reads as "checked" for a label nobody ever
-- read — the exact failure R1's whole mechanism exists to prevent. A user_food key gets the same
-- treatment: it must belong to this same user_id, at the exact rev it names (a later revision
-- needs a fresh check, same rule lib/server/allergen-evidence.ts markLabelChecked's own
-- expectedRevisions enforces from the app side). SECURITY DEFINER and an empty search_path
-- (20261103090100_same_owner_references.sql's pattern) so the check runs for every writer, not
-- only the RLS-visible rows the calling role can already see.
create or replace function public._validate_allergen_check_food_key() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_catalog_id bigint;
  v_user_food_id uuid;
  v_rev int;
begin
  if new.food_key ~ '^catalog_revision:[0-9]+$' then
    v_catalog_id := split_part(new.food_key, ':', 2)::bigint;
    if not exists (select 1 from public.catalog_food_revisions where id = v_catalog_id) then
      raise exception 'user_allergen_checks: no such catalog revision (%)', new.food_key
        using errcode = '23503';
    end if;
    return new;
  end if;
  if new.food_key ~ '^user_food:[0-9a-f-]{36}:[0-9]+$' then
    v_user_food_id := split_part(new.food_key, ':', 2)::uuid;
    v_rev := split_part(new.food_key, ':', 3)::int;
    if not exists (
      select 1 from public.user_foods
       where id = v_user_food_id and rev = v_rev and user_id = new.user_id) then
      raise exception 'user_allergen_checks: no matching user food at that revision (%)', new.food_key
        using errcode = '23503';
    end if;
    return new;
  end if;
  raise exception 'user_allergen_checks: unrecognized food_key (%)', new.food_key
    using errcode = '23514';
end $$;

create trigger user_allergen_checks_validate_food_key
  before insert or update on user_allergen_checks
  for each row execute function public._validate_allergen_check_food_key();

-- ---------- legacy conversion (R2) ---------------------------------------------------------
-- The allergen keys lib/policy/allergens.ts EVIDENCE_KEYS stores, and the legacy tag spellings
-- (lib/catalog/off-map.ts, lib/capture/propose.ts) that name each of them.
-- sol finding (BLOCK, round 2): a legacy species tag (OFF's own taxonomy tags several tree-nut
-- and wheat species individually — 'almonds', 'spelt', ...) had no row here, so it never matched
-- its group key below and backfilled as no_evidence for tree-nut/wheat despite the explicit
-- declaration — the exact "a later user check can allow a food that has an explicit allergen tag"
-- failure. Mirrors lib/catalog/off-map.ts's TAG_ALIASES species list, the runtime map for the
-- same tags. Wheat species also recover the gluten key via an explicit OR clause below (this
-- table is one tag to one allergen; off-map.ts's array mapping needs the second clause here).
--
-- review round 2 (sol/BLOCK): 'barley' and 'rye' are gluten sources but not wheat species
-- (off-map.ts's GLUTEN regex and TAG_ALIASES both map them to gluten alone, never wheat) — a row
-- for each closes the same "explicit tag reads as no_evidence" gap the tree-nut/wheat fix above
-- closes, for the two gluten spellings that fix's wheat-species list does not cover.
--
-- review round 2 (sol/FIX): 'tree nut' (no hyphen), 'tree_nut' (underscore) and 'crustacean
-- shellfish' are also spellings lib/policy/allergens.ts's own `allergenKey` ALIASES table
-- resolves to 'tree-nut'/'crustacean' at read time — every one of THOSE spellings needs its own
-- row here too, or a legacy tag using one backfills as a separate raw row (e.g. allergen =
-- 'tree nut') beside the canonical 'tree-nut' row for the same food_key. Both rows read as the
-- same key once `allergenKey` normalizes them, but they are two distinct primary keys
-- (food_key, allergen) in this table, so `lib/server/allergen-evidence.ts`'s read of the two ends
-- up with whichever one a plain, unordered select happened to return last — not a merge, and not
-- deterministic.
create table _p13_allergen_alias (tag text primary key, allergen text not null);
insert into _p13_allergen_alias (tag, allergen) values
  ('dairy', 'dairy'), ('milk', 'dairy'), ('lactose', 'dairy'),
  ('egg', 'egg'), ('eggs', 'egg'),
  ('soy', 'soy'), ('soya', 'soy'), ('soybean', 'soy'), ('soybeans', 'soy'),
  ('peanut', 'peanut'), ('peanuts', 'peanut'),
  ('tree-nut', 'tree-nut'), ('tree nuts', 'tree-nut'), ('tree nut', 'tree-nut'),
  ('tree_nut', 'tree-nut'), ('nuts', 'tree-nut'),
  ('almond', 'tree-nut'), ('almonds', 'tree-nut'), ('cashew', 'tree-nut'),
  ('cashews', 'tree-nut'), ('walnut', 'tree-nut'), ('walnuts', 'tree-nut'),
  ('pecan', 'tree-nut'), ('pecans', 'tree-nut'), ('pistachio', 'tree-nut'),
  ('pistachios', 'tree-nut'), ('hazelnut', 'tree-nut'), ('hazelnuts', 'tree-nut'),
  ('filbert', 'tree-nut'), ('filberts', 'tree-nut'), ('macadamia', 'tree-nut'),
  ('macadamias', 'tree-nut'), ('macadamia-nuts', 'tree-nut'), ('brazil-nut', 'tree-nut'),
  ('brazil-nuts', 'tree-nut'), ('pine-nut', 'tree-nut'), ('pine-nuts', 'tree-nut'),
  ('fish', 'fish'),
  ('sesame', 'sesame'), ('sesame-seeds', 'sesame'),
  ('wheat', 'wheat'),
  ('spelt', 'wheat'), ('kamut', 'wheat'), ('triticale', 'wheat'), ('einkorn', 'wheat'),
  ('farro', 'wheat'),
  ('gluten', 'gluten'), ('barley', 'gluten'), ('rye', 'gluten'),
  ('shellfish', 'shellfish'), ('crustaceans', 'shellfish'), ('molluscs', 'shellfish'),
  ('crustacean shellfish', 'crustacean');

create table _p13_allergen_key (allergen text primary key);
insert into _p13_allergen_key (allergen) values
  ('dairy'), ('egg'), ('soy'), ('peanut'), ('tree-nut'), ('fish'), ('sesame'), ('wheat'),
  ('gluten'), ('shellfish'), ('crustacean');

-- Live user foods: every key, listed where a legacy tag names it, else no_evidence. The old OFF
-- mapping aliased a declared 'wheat' tag onto 'gluten' before lib/catalog/off-map.ts stopped
-- doing that (finding #8: wheat is its own FALCPA rule, distinct from the broader gluten one) —
-- an existing row tagged only 'gluten' may be exactly that recovered-nowhere-else history, so the
-- wheat key also reads a 'gluten' tag as listed here, in this one-time conversion only. Never the
-- reverse (a 'wheat' tag was never generic gluten under the old mapping), and never at runtime
-- (lib/catalog/off-map.ts's TAG_ALIASES is unchanged): over-flagging wheat this one time is the
-- safe direction R1 asks for; under-flagging a wheat-containing legacy product is not.
-- finding #9: 'crustacean' has no row of its own in _p13_allergen_alias (a legacy 'crustaceans' tag
-- already resolves to 'shellfish' there, and a tag maps to exactly one allergen) — recovered here
-- the same one-off way as the wheat/gluten case just below it, from the spellings a legacy tag or
-- lib/catalog/off-map.ts's mapping could actually have used for it.
insert into food_allergen_evidence (food_key, allergen, level, label_complete, source, user_id)
select 'user_food:' || uf.id || ':' || uf.rev, k.allergen,
       case when exists (
         select 1 from unnest(uf.allergen_tags) t
           left join _p13_allergen_alias a on a.tag = lower(btrim(t))
          where coalesce(a.allergen, lower(btrim(t))) = k.allergen
             or (k.allergen = 'wheat' and lower(btrim(t)) = 'gluten')
             or (k.allergen = 'gluten' and lower(btrim(t)) in
                 ('spelt', 'kamut', 'triticale', 'einkorn', 'farro'))
             or (k.allergen = 'crustacean' and lower(btrim(t)) in
                 ('crustacean', 'crustaceans', 'shrimp', 'shrimps', 'prawn', 'prawns', 'crab',
                  'crabs', 'lobster', 'lobsters', 'crayfish', 'crawfish')))
         then 'listed' else 'no_evidence' end,
       false, 'legacy', uf.user_id
  from user_foods uf cross join _p13_allergen_key k
 where uf.deleted_at is null;

-- A legacy user-food tag outside the key list (e.g. 'mustard', 'apple') stays listed under its name.
insert into food_allergen_evidence (food_key, allergen, level, label_complete, source, user_id)
select distinct 'user_food:' || uf.id || ':' || uf.rev, lower(btrim(t)), 'listed', false, 'legacy',
       uf.user_id
  from user_foods uf cross join unnest(uf.allergen_tags) t
 where uf.deleted_at is null and btrim(t) <> ''
   and not exists (select 1 from _p13_allergen_alias a where a.tag = lower(btrim(t)))
on conflict (food_key, allergen) do nothing;

-- Catalog revisions with ingredient rows: the same, from the union of their rows' tags, and the
-- same one-time wheat/gluten recovery as the user-foods block above.
insert into food_allergen_evidence (food_key, allergen, level, label_complete, source, user_id)
select 'catalog_revision:' || r.id, k.allergen,
       case when exists (
         select 1 from catalog_ingredients ci cross join unnest(ci.allergen_tags) t
           left join _p13_allergen_alias a on a.tag = lower(btrim(t))
          where ci.food_revision_id = r.id
            and (coalesce(a.allergen, lower(btrim(t))) = k.allergen
                 or (k.allergen = 'wheat' and lower(btrim(t)) = 'gluten')
                 or (k.allergen = 'gluten' and lower(btrim(t)) in
                     ('spelt', 'kamut', 'triticale', 'einkorn', 'farro'))
                 or (k.allergen = 'crustacean' and lower(btrim(t)) in
                     ('crustacean', 'crustaceans', 'shrimp', 'shrimps', 'prawn', 'prawns', 'crab',
                      'crabs', 'lobster', 'lobsters', 'crayfish', 'crawfish'))))
         then 'listed' else 'no_evidence' end,
       false, 'legacy', null
  from catalog_food_revisions r cross join _p13_allergen_key k
 where exists (select 1 from catalog_ingredients ci where ci.food_revision_id = r.id);

insert into food_allergen_evidence (food_key, allergen, level, label_complete, source, user_id)
select distinct 'catalog_revision:' || ci.food_revision_id, lower(btrim(t)), 'listed', false,
       'legacy', null::uuid
  from catalog_ingredients ci cross join unnest(ci.allergen_tags) t
 where btrim(t) <> ''
   and not exists (select 1 from _p13_allergen_alias a where a.tag = lower(btrim(t)))
on conflict (food_key, allergen) do nothing;

-- The two helper tables exist only for this conversion.
drop table _p13_allergen_alias;
drop table _p13_allergen_key;

-- Down: supabase/migrations/down/20261118090000_allergen_evidence.down.sql drops both tables.

-- Internal functions: none is an RPC. Postgres grants execute to public on a new function, and the
-- rpc-matrix gate (tests/tenancy/rpc-matrix.test.ts) treats anything authenticated may execute as
-- an RPC that must be declared; a trigger fires without its caller holding execute.
revoke all on function public._p13_allergen_evidence_rank(text) from public, anon, authenticated;
revoke all on function public._p13_monotonic_allergen_evidence() from public, anon, authenticated;
revoke all on function public._validate_allergen_check_food_key() from public, anon, authenticated;
