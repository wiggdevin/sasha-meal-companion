-- Lane G. Ranked catalog text search — architecture §4.1, frozen in
-- docs/plans/2026-09-11-phase-1-2/00-contracts.md §2.
--
-- security invoker: auth.uid() is the caller, and RLS governs every read of
-- user_food_prefs, log_entries and log_items. Only the caller's own prefs and
-- log counts can move the score. A security definer variant for the privileged
-- boundary waits for Phase 7 (Phase 1 spec, Search RPC).
--
-- unaccent() and similarity() are called unqualified: on the live branches
-- Phase 0 installed both extensions in schema public, so an `extensions.`
-- prefix would not resolve there. The pinned search_path (public, extensions,
-- pg_temp) is what makes the calls stable whichever schema actually holds the
-- extensions, whatever the caller's own search_path is.
--
-- The seven feature columns are rounded to 6 decimals and the score is computed
-- from those rounded columns and rounded to 6 decimals, so lib/search/features.ts
-- combine(featuresFromRow(row)) agrees with `score` to within 1e-6 —
-- tests/search/score-parity.test.ts asserts that tolerance.

-- Load pg_trgm's library in this backend so its GUC is registered before the
-- per-function SET below; a fresh session (supabase db push) would otherwise
-- refuse to set a placeholder parameter.
select similarity('prime', 'prime');

create or replace function public.catalog_search(
  p_q text,
  p_brand text default null,
  p_prep text default null,
  p_limit integer default 25
)
returns table (
  catalog_food_id bigint,
  revision_id bigint,
  description text,
  brand text,
  source text,
  quality_class text,
  quality_flags text[],
  prep_state text,
  score numeric,
  pref_status text,
  f_lexical numeric,
  f_trigram numeric,
  f_brand numeric,
  f_prep numeric,
  f_prior numeric,
  f_quality numeric,
  f_eats numeric
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
set pg_trgm.similarity_threshold = 0.25
as $$
  with q as (
    select
      websearch_to_tsquery('english', unaccent(coalesce(p_q, ''))) as tsq,
      unaccent(lower(coalesce(p_q, '')))                           as raw,
      nullif(btrim(coalesce(p_brand, '')), '')                     as qbrand,
      nullif(nullif(btrim(coalesce(p_prep, '')), ''), 'unknown')   as qprep,
      auth.uid()                                                   as uid
  ),
  cand as (
    select
      r.catalog_food_id                                                        as catalog_food_id,
      r.id                                                                     as revision_id,
      r.description                                                            as description,
      r.brand                                                                  as brand,
      cf.source                                                                as source,
      r.quality_class                                                          as quality_class,
      r.quality_flags                                                          as quality_flags,
      r.prep_state                                                             as prep_state,
      pref.status                                                              as pref_status,
      round(ts_rank(r.search_doc, q.tsq, 32)::numeric, 6)           as f_lexical,
      round(similarity(r.description, q.raw)::numeric, 6)           as f_trigram,
      round(
        case
          when q.qbrand is null then 0
          when regexp_replace(lower(unaccent(btrim(coalesce(r.brand, '')))), '\s+', ' ', 'g')
             = regexp_replace(lower(unaccent(btrim(q.qbrand))), '\s+', ' ', 'g')  then 1
          when similarity(coalesce(r.brand, ''), q.qbrand) >= 0.6 then 0.6
          else 0
        end, 6)                                                                as f_brand,
      round(
        case
          when q.qprep is null or r.prep_state is null or r.prep_state = 'unknown' then 0.5
          when r.prep_state = q.qprep                  then 1
          else 0
        end, 6)                                                                as f_prep,
      round(least(1::numeric, ln(1 + coalesce(p.logs_90d, 0)) / ln(21::numeric)), 6) as f_prior,
      round(greatest(0::numeric,
            case r.quality_class
              when 'analytical' then 1.0 when 'survey' then 0.75
              when 'label'      then 0.5 else 0.25 end
          - case when 'energy_mismatch' = any(r.quality_flags) then 0.25 else 0 end), 6) as f_quality,
      round(
        case pref.status when 'eats' then 1 when 'avoid' then 0 else 0.5 end::numeric, 6) as f_eats
    from public.catalog_food_revisions r
    cross join q
    join public.catalog_versions v on v.id = r.catalog_version_id and v.is_active
    join public.catalog_foods    cf on cf.id = r.catalog_food_id
    left join public.food_refs   fr on fr.catalog_food_id = r.catalog_food_id
    left join public.user_food_prefs pref
           on pref.food_ref_id = fr.id and pref.user_id = q.uid
    left join lateral (
      select count(*)::numeric as logs_90d
        from public.log_items li
        join public.log_entries le on le.id = li.entry_id
       where fr.id is not null
         and li.food_ref_id = fr.id
         and le.user_id = q.uid
         and le.deleted_at is null
         and le.local_date > current_date - 90
    ) p on true
    -- `%` is the indexable form of the trigram gate (gin_trgm_ops only supports
    -- the `%` operator, not a bare similarity() comparison); the pinned GUC
    -- above holds its threshold at 0.25 so `%` matches similarity() > 0.25.
    where r.is_active
      and (r.search_doc @@ q.tsq or r.description % q.raw)
  )
  select
    catalog_food_id, revision_id, description, brand, source, quality_class, quality_flags, prep_state,
    round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep
        + 0.10 * f_prior  + 0.05 * f_quality + 0.05 * f_eats, 6) as score,
    pref_status, f_lexical, f_trigram, f_brand, f_prep, f_prior, f_quality, f_eats
  from cand
  order by score desc, revision_id asc
  limit least(greatest(coalesce(p_limit, 25), 1), 25);
$$;

revoke execute on function public.catalog_search(text, text, text, integer) from public, anon;
grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role;

comment on function public.catalog_search(text, text, text, integer) is
  'Ranked catalog text search (architecture §4.1). security invoker: auth.uid() is the caller, so the user_prior and eats_status features read only the caller''s own rows.';
