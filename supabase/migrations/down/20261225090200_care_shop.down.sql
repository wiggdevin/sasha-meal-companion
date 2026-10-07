-- Reverse of 20261225090200_care_shop.sql. Refuses while any account owns an item, unless
-- app.allow_down_data_loss = on: dropping the tables would forget every purchase.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and to_regclass('public.care_inventory') is not null
     and exists (select 1 from public.care_inventory) then
    raise exception 'care_shop down: accounts own shop items; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.care_equip(uuid, text, text, integer);
drop function if exists public.care_purchase(uuid, text, uuid, date, text);
drop table if exists public.care_purchase_receipts;
drop table if exists public.care_equipped;
drop table if exists public.care_inventory;
drop table if exists public.care_items;
