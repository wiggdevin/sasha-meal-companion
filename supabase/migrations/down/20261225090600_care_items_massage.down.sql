-- Reverse of 20261225090600_care_items_massage.sql. Refuses while any account owns the item or
-- holds a purchase receipt for it (both care_inventory.item_id and care_purchase_receipts.item_id
-- reference care_items with no cascade), unless app.allow_down_data_loss = on -- in which case it
-- also clears those referencing rows first, so the escape hatch actually succeeds (Sol review
-- WARN: the first version checked and deleted only care_inventory, so a cleared inventory with a
-- receipt still on file -- or the flag set without clearing either -- left the delete to fail on
-- the FK anyway).
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and (exists (select 1 from public.care_inventory where item_id = 'massage')
          or exists (select 1 from public.care_purchase_receipts where item_id = 'massage')) then
    raise exception 'care_items_massage down: an account owns it or holds a receipt for it; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end $$;

delete from public.care_purchase_receipts where item_id = 'massage';
delete from public.care_inventory where item_id = 'massage';
delete from public.care_items where id = 'massage';
