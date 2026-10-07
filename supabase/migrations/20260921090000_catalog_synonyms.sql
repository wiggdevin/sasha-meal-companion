-- Lane O. Search recall — contracts docs/plans/2026-09-11-phase-3-4/00-contracts.md §7.
--
-- docs/catalog/relevance.md (2026-09-11) measured top-1 42.6 % / top-3 77.1 % against the Phase 1
-- gate of 85 % / 95 % and named two causes that live OUTSIDE the architecture §4.1 score:
-- candidate recall (the right row never reaches the scorer) and the absence of a vocabulary layer
-- ("albacore" is USDA's "tuna, white"). This migration fixes both. It does not touch the score:
-- catalog_search keeps its signature, its return columns and its score expression byte for byte.
--
-- Rows are curated in docs/catalog/synonyms.csv and loaded by scripts/load-synonyms.ts, which
-- makes this table equal that file. The table is shared, read-only reference data with no user
-- rows in it at all — the same shape as catalog_nutrients — so, per contracts §7, it carries no
-- RLS policy and authenticated holds select and nothing else.

create table if not exists public.catalog_synonyms (
  term      text primary key,
  expansion text not null,
  source    text not null default 'curated'
);

comment on table public.catalog_synonyms is
  'Query vocabulary for catalog_search (contracts §7). Source of truth: docs/catalog/synonyms.csv.';

revoke all on table public.catalog_synonyms from public, anon, authenticated;
grant select on table public.catalog_synonyms to authenticated;
grant all    on table public.catalog_synonyms to service_role;

-- The vocabulary layer. Lowercase, unaccent, split on whitespace, then replace: a two-word term
-- first, a single token otherwise. Each token is consumed once, so an expansion is never expanded
-- a second time and the table cannot cycle. lib/search/query.ts's expandQuery() is the same
-- algorithm in TypeScript and tests/search/recall.test.ts holds the two together.
--
-- Two-word terms are not a flourish: docs/catalog/synonyms.csv needs 'duck fat' and
-- 'pumpkin puree', and it needs 'egg whites' to fire before the 'egg' row does, or the query
-- "egg whites" would expand to "egg whole whites" and lose its own target under the AND that
-- websearch_to_tsquery applies.
create or replace function public.catalog_expand_query(p_q text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  toks      text[];
  out_parts text[] := '{}';
  n         integer;
  i         integer := 1;
  hit       text;
begin
  toks := array_remove(
            regexp_split_to_array(btrim(lower(unaccent(coalesce(p_q, '')))), '\s+'),
            '');
  n := coalesce(array_length(toks, 1), 0);
  while i <= n loop
    hit := null;
    if i < n then
      select s.expansion into hit
        from public.catalog_synonyms s
       where s.term = toks[i] || ' ' || toks[i + 1];
    end if;
    if hit is not null then
      out_parts := out_parts || hit;
      i := i + 2;
    else
      select s.expansion into hit
        from public.catalog_synonyms s
       where s.term = toks[i];
      out_parts := out_parts || coalesce(hit, toks[i]);
      i := i + 1;
    end if;
  end loop;
  return btrim(array_to_string(out_parts, ' '));
end;
$$;

revoke execute on function public.catalog_expand_query(text) from public, anon;
grant  execute on function public.catalog_expand_query(text) to authenticated, service_role;

comment on function public.catalog_expand_query(text) is
  'Expands a search query through catalog_synonyms (contracts §7). Mirrored by expandQuery() in lib/search/query.ts.';

-- Load pg_trgm's library in this backend so BOTH of its GUCs are registered before the
-- per-function SET clauses below; a fresh session (supabase db push) would otherwise refuse to
-- set a placeholder parameter. Same line, same reason, as 20260912090100_catalog_search.sql.
select similarity('prime', 'prime');

-- catalog_search, re-created. THE SCORE DOES NOT CHANGE. For the record, the expression this
-- function carried before this migration and carries after it, byte for byte:
--
--     round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep
--         + 0.10 * f_prior  + 0.05 * f_quality + 0.05 * f_eats, 6) as score
--
-- and every one of the seven feature columns that feeds it is computed from the same inputs as
-- before, because `q.raw` is still the UNEXPANDED query: f_trigram is still
-- similarity(r.description, q.raw). architecture §4.1's weights, mappings and rounding are
-- untouched, so lib/search/features.ts needs no edit and tests/search/score-parity.test.ts
-- passes unmodified.
--
-- Exactly three things change, and all three are recall, not ranking:
--
--   1. q.tsq is built from catalog_expand_query(p_q) instead of p_q. "canned albacore" becomes
--      "tuna white canned", which reaches "Fish, tuna, white, canned in water, drained solids" —
--      a row no lexical or trigram feature could ever have found from the word "albacore".
--   2. The candidate where-clause gains a word-similarity branch (contracts §7):
--        search_doc @@ tsq OR similarity(description, raw) > 0.25 OR word_similarity(raw, description) > 0.45
--      written with the indexable operators. `%` is similarity() > its GUC and `<%` is
--      word_similarity() > its GUC; both GUCs are pinned per-function below, so the operators and
--      the functions in §7's clause are the same predicate — and gin_trgm_ops can serve them,
--      which a bare function comparison cannot.
--   3. pg_trgm.word_similarity_threshold is pinned at 0.45 for the same reason 0.25 is pinned.
--
-- Contracts §7 also lists a fourth candidate branch, `search_doc @@ to_tsquery('english', <expanded
-- terms>)`. It is subsumed: tsq IS the expanded query here, so that branch and branch 1 are the
-- same predicate. Nothing is dropped.
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
    pref_status, f_lexical, f_trigram, f_brand, f_prep, f_prior, f_quality, f_eats
  from cand
  order by score desc, revision_id asc
  limit least(greatest(coalesce(p_limit, 25), 1), 25);
$$;

revoke execute on function public.catalog_search(text, text, text, integer) from public, anon;
grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role;

comment on function public.catalog_search(text, text, text, integer) is
  'Ranked catalog text search (architecture §4.1, score unchanged). security invoker: auth.uid() is the caller, so the user_prior and eats_status features read only the caller''s own rows. Lane O widened the candidate set and expanded the query through catalog_synonyms.';
