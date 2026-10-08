-- Migration 6 (phase-18 W11, docs/specs/phase-18-open-world-foods.md §W11, D7). "Use my shopping
-- list": a timed opt-in, server-written, read by every plate generator while active. `null` is
-- off; a past timestamp is also off (the read side treats "expired" the same as "unset" — no
-- separate boolean, so there is nothing for a forgotten end date to leave stuck on).
--
-- RLS: `user_settings` already has its owner policy (every prior migration on this table inherits
-- it); a new nullable column needs no backfill and no policy change.
--
-- Live-safe: one nullable column, no default (metadata-only, no table rewrite). Down:
-- supabase/migrations/down/20261227090000_shopping_focus.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings
  add column shopping_focus_until timestamptz;

comment on column public.user_settings.shopping_focus_until is
  'D7 shopping focus ("use my shopping list"): while now() < this, every plate generator ranks by '
  '(fits the slot, list/pantry coverage, score). Null or past is off. Server-written only '
  '(set_shopping_focus / its Undo), default end = the open shopping period''s end or 7 days, '
  'max 31 days out.';
