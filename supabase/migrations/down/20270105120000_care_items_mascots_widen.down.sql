-- Reverse of 20270105120000_care_items_mascots_widen.sql: the seven wearables go back to the
-- array['sprout'] 20261225090200_care_shop.sql seeded. No data loss: nothing owned or equipped
-- reads the column. Massage is untouched.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

update public.care_items
   set mascots = array['sprout']
 where id in ('leaf-pin', 'mittens', 'bucket-hat', 'knitted-hat', 'glasses', 'sunglasses', 'shorts')
   and mascots is distinct from array['sprout'];
