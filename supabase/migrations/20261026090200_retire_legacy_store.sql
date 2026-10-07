-- The singleton JSON store is retired with /api/sync. Production holds no rows.
drop table if exists public.foods;
drop table if exists public.days;
drop table if exists public.settings;
