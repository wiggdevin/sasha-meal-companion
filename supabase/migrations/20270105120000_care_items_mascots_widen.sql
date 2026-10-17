-- W145 (B266): widen care_items.mascots for the seven wearables 20261225090200_care_shop.sql seeded
-- with array['sprout'] only. `mascots` means "can wear": the companions whose own art has a place
-- for the item, exactly components/today/care/shop/catalog.ts's `canWear` (an item's `places` for
-- Sprout plus its `fits` for the others). Pod (peapod) has no head, so neither hat lists it (#24).
-- Massage (20261225090600) is a care scene, not worn, and already lists all four; it is untouched.
--
-- Widen only: each row gains the companions it lacks, in catalog order, and keeps any it already
-- has, so a re-run (or a row the owner already edited by hand) changes nothing.
--
-- Nothing on the server enforces the column: care_equip never reads it and GET /api/care/shop only
-- reports it, so the phone decides what a companion wears from catalog.ts either way. Either order
-- against the deploy is safe.
--
-- Live-safe: an update of seven rows in a small catalog table, no DDL.
-- Down: supabase/migrations/down/20270105120000_care_items_mascots_widen.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

update public.care_items as c
   set mascots = c.mascots || array(select m from unnest(w.wearers) with ordinality as t(m, n)
                                     where m <> all(c.mascots) order by n)
  from (values
    ('leaf-pin', array['sprout', 'blueberry', 'mushroom', 'peapod']),
    ('mittens', array['sprout', 'blueberry', 'mushroom', 'peapod']),
    ('bucket-hat', array['sprout', 'blueberry', 'mushroom']),
    ('knitted-hat', array['sprout', 'blueberry', 'mushroom']),
    ('glasses', array['sprout', 'blueberry', 'mushroom', 'peapod']),
    ('sunglasses', array['sprout', 'blueberry', 'mushroom', 'peapod']),
    ('shorts', array['sprout', 'blueberry', 'mushroom', 'peapod'])
  ) as w(id, wearers)
 where c.id = w.id
   and not (c.mascots @> w.wearers);
