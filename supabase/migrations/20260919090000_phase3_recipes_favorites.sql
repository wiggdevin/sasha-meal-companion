-- Phase 3, contracts §3 "Reconciled data changes". Phase 0 (20260911000200_user_schema.sql)
-- already created recipes, recipe_revisions, recipe_items, favorites_foods, favorites_recipes,
-- favorites_meals and favorites_meal_items, and 20260911000500_rls.sql already enabled their
-- RLS with the §2.1 policy pairs. This migration adds only what the sync envelope needs.
--
-- deleted_at on the favorites tables is what keeps "deletes dominate" (architecture §3.7) true
-- under a set-union merge: without a tombstone, a favorite she removed on the phone is
-- resurrected by the laptop's copy on the next pull.
--
-- created_at is a real "date added": set once at insert, and _sync_upsert's on-conflict clause
-- never assigns it, so re-sorting a favorite (which does touch updated_at) leaves it alone.

alter table favorites_foods
  add column rev integer not null default 1,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

alter table favorites_recipes
  add column rev integer not null default 1,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

-- favorites_meals already carries rev (Phase 0); it lacks the stamps and the tombstone.
alter table favorites_meals
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

-- recipes already carries rev and deleted_at; serverTimestampOf (lib/sync/outbox.ts) reads
-- updated_at first, so a conflict on a recipe compares real stamps instead of falling back to now.
alter table recipes
  add column updated_at timestamptz not null default now();
