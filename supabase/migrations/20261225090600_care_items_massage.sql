-- UI-NEEDS CARE-MASSAGE (coord.md 2026-10-07T13:14Z): care_items (20261225090200) seeded the
-- seven wearables but not the Massage care scene that landed in the UI
-- (components/today/care/shop/catalog.ts). Seeds that one row so the shop can sell it.
--
-- Idempotent on purpose (`on conflict do nothing`), unlike 20261225090200's own plain insert:
-- this migration adds a single catalog row to an existing seeded table rather than seeding a
-- table it also creates, so a re-run (or a row the owner already added by hand) must not raise.
--
-- `id`/`slot`/`price`/`asset_key` match catalog.ts's own `massage` entry exactly, byte for byte
-- (id: "massage", slot: "care", price: 30, art: "/pet/care/massage-1.webp"); `tier` is "care"
-- (care_items.tier check already allows it, from 20261225090200). A care item is never equipped
-- (the UI never calls POST /api/care/equip for one), so `slot: "care"` only ever surfaces through
-- GET /api/care/shop's catalog listing.
--
-- Live-safe: one row insert into an existing table, no lock beyond the implicit row lock.
-- Down: supabase/migrations/down/20261225090600_care_items_massage.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

insert into public.care_items (id, slot, tier, price, asset_key, mascots)
values ('massage', 'care', 'care', 30, '/pet/care/massage-1.webp', array['sprout', 'blueberry', 'mushroom', 'peapod'])
on conflict (id) do nothing;
