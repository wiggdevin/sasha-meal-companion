-- W122 (docs/readiness/2026-10-17/README.md §3): the Supabase advisor flags three plain SECURITY
-- INVOKER functions with a mutable search_path. Pin it. `public` stays first because the bodies use
-- unqualified public tables (food_refs, catalog_*) and public.unaccent; pg_temp is last so a temp
-- object can never shadow one. Metadata-only (ALTER FUNCTION ... SET), no rewrite, grants unchanged.
set local lock_timeout = '3s';

alter function public._sync_assert_key(text, text) set search_path = public, pg_temp;
alter function public.catalog_search_doc(text, text, text) set search_path = public, pg_temp;
alter function public.compute_item_snapshot(uuid, numeric) set search_path = public, pg_temp;
