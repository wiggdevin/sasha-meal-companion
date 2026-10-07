-- Reverse of 20261225090600_care_items_massage.sql. Refuses while any account owns the item,
-- unless app.allow_down_data_loss = on: dropping the row would forget that purchase.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from public.care_inventory where item_id = 'massage') then
    raise exception 'care_items_massage down: an account owns it; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end $$;

delete from public.care_items where id = 'massage';
