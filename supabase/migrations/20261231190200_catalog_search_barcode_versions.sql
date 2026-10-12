-- W059 (audit 2026-10-10 B007 / loop010 F-055): barcode foods appear in name search.
--
-- catalog_write_provider_revision (current body 20261018090000) files every scan under a per-day
-- `off-YYYY-MM-DD` / `fdc_branded-YYYY-MM-DD` catalog_versions row with is_active = false: the
-- one-active-version-per-source index and the bulk activation flow are for the USDA imports, so a
-- scan cannot activate its own version. catalog_search joined only active versions, so a food
-- that was just scanned returned no hit when its own name was typed back.
--
-- The one change: the version join also accepts the two barcode sources. Which revision is live
-- for a barcode food is still decided by catalog_food_revisions.is_active, which the writer keeps
-- to exactly one per food (it stands the older day's revision down and upserts the same day's),
-- so a rescan never adds a second hit. No bulk import writes 'off' or 'fdc_branded'
-- (scripts/import-fdc.py SOURCES), so nothing staged and unreviewed becomes searchable.
--
-- Everything else is 20261018090200's body byte for byte: same signature, same 19 return columns,
-- same candidate clause, same pinned GUCs and THE SAME SCORE EXPRESSION, so lib/search/features.ts
-- and tests/search/score-parity.test.ts are untouched. The return type is unchanged, so CREATE OR
-- REPLACE works; the grants are restated anyway.
--
-- No app code reads anything new, but apply it to production BEFORE the W059 PR merges, so the
-- release and its DB test describe the same function.
-- Down: supabase/migrations/down/20261231190200_catalog_search_barcode_versions.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- pg_trgm's GUCs must be registered in this backend before the per-function SET clauses
-- below; same line, same reason, as 20260912090100 and 20260921090000.
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
  category text,
  policy_categories text[],
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
set pg_trgm.word_similarity_threshold = 0.45
as $$
  with q as (
    select
      websearch_to_tsquery('english', unaccent(public.catalog_expand_query(p_q))) as tsq,
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
      r.category                                                               as category,
      r.policy_categories                                                      as policy_categories,
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
    -- W059: barcode versions are never activated (see the header); the revision's own is_active
    -- below keeps one live row per barcode food.
    join public.catalog_versions v on v.id = r.catalog_version_id
                                  and (v.is_active or v.source in ('off', 'fdc_branded'))
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
    -- `%` and `<%` are the indexable forms of the two trigram gates (gin_trgm_ops supports the
    -- operators, not bare similarity()/word_similarity() comparisons); the pinned GUCs above hold
    -- their thresholds at 0.25 and 0.45, so this clause is exactly contracts §7's
    -- `similarity(description, raw) > 0.25 OR word_similarity(raw, description) > 0.45`.
    where r.is_active
      and (r.search_doc @@ q.tsq or r.description % q.raw or q.raw <% r.description)
  )
  select
    catalog_food_id, revision_id, description, brand, source, quality_class, quality_flags, prep_state,
    round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep
        + 0.10 * f_prior  + 0.05 * f_quality + 0.05 * f_eats, 6) as score,
    pref_status, category, policy_categories,
    f_lexical, f_trigram, f_brand, f_prep, f_prior, f_quality, f_eats
  from cand
  order by score desc, revision_id asc
  limit least(greatest(coalesce(p_limit, 25), 1), 25);
$$;

revoke execute on function public.catalog_search(text, text, text, integer) from public, anon;
grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role;

comment on function public.catalog_search(text, text, text, integer) is
  'Ranked catalog text search (architecture §4.1, score unchanged). security invoker: auth.uid() is the caller, so the user_prior and eats_status features read only the caller''s own rows. Lane O widened the candidate set and expanded the query through catalog_synonyms. W059: barcode (off, fdc_branded) versions are searched although never activated.';
