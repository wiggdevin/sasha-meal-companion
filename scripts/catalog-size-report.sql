-- Per-table and per-index size for the catalog, plus headroom against the Supabase Pro disk.
-- pg_total_relation_size on a table already counts its indexes and TOAST, so the total sums
-- tables only; indexes are listed separately with pg_relation_size to show where the bytes went.
\set QUIET on
\pset border 2
\unset QUIET

\echo '## Tables'
select c.relname as table,
       (select count(*) from pg_class i
         join pg_index x on x.indexrelid = i.oid where x.indrelid = c.oid) as indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_total_relation_size(c.oid) as total_bytes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'catalog\_%'
 order by pg_total_relation_size(c.oid) desc;

\echo '## Indexes'
select c.relname as index,
       pg_size_pretty(pg_relation_size(c.oid)) as size,
       pg_relation_size(c.oid) as size_bytes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'i' and c.relname like 'catalog\_%'
 order by pg_relation_size(c.oid) desc;

\echo '## Headroom (Supabase Pro disk = 8 GiB)'
select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as catalog_total,
       round((100.0 * sum(pg_total_relation_size(c.oid)) / (8 * 1024 ^ 3))::numeric, 1) as used_pct_of_8gib,
       round((100.0 - 100.0 * sum(pg_total_relation_size(c.oid)) / (8 * 1024 ^ 3))::numeric, 1) as headroom_pct
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'catalog\_%';

\echo '## Energy mismatch rate per version'
select v.source, v.version_label, v.is_active, v.row_counts ->> 'revisions' as revisions,
       v.row_counts ->> 'energy_mismatch_rate' as energy_mismatch_rate,
       v.row_counts ->> 'macro_coverage' as macro_coverage
  from catalog_versions v order by v.source, v.version_label;
