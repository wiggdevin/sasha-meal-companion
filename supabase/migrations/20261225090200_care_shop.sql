-- UI-NEEDS SPROUT-CARE item 2 (coord.md 2026-10-07T04:15Z). Shapes mirror the UI lane's already-
-- landed presentation model (components/today/care/shop/{catalog,shop-state}.ts, #500) so it can
-- wire in with minimal change:
--
--   care_items       the catalog: id, slot, tier, price (Seeds), asset_key, which mascots can wear
--                    it, active, version. Seeded here with the same ids/slots/prices
--                    catalog.ts's SHOP_ITEMS already uses, so GET /api/care/shop answers the same
--                    shop the gallery has been showing on samples.
--   care_inventory   one row per account and owned item (what shop-state.ts calls `owned`).
--   care_equipped    ONE row per account: an `equipped` map (slot -> item id) and a single `rev`
--                    that moves on every equipment change. This is a deliberate reading of the
--                    owner checklist's "(user_id, slot, item_id, rev)": shop-state.ts's own
--                    `ShopState.rev` is one optimistic-concurrency token for the WHOLE equipped
--                    map, not one per slot, so a single-row table is what actually matches the
--                    contract the UI already built against. Flagged here per CONTRACT SPROUT-CARE
--                    in coord.md.
--   care_purchase_receipts   one immutable row per purchase action id (shop-state.ts `purchase`'s
--                    idempotency key), so a retried POST answers the first receipt rather than
--                    double-charging.
--
-- `care_purchase` and `care_equip` are the only writers. `care_purchase` takes the same
-- per-account `:care_points` advisory lock `care_points_sync` does, so a purchase can never race
-- an award into reading a stale balance. `care_equip` takes its own `:care_equip` lock (it never
-- reads or writes a balance, so sharing the points lock would only add needless contention; Sol
-- review NIT -- an earlier draft of this comment overclaimed a shared lock between all three).
-- Nothing here trusts a price, balance or ownership claim from the caller -- every check
-- re-reads the real rows under its own lock.
--
-- Live-safe: three new tables, RLS on from creation, two new functions, one seeded catalog.
-- Down: supabase/migrations/down/20261225090200_care_shop.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.care_items') is not null then
    raise exception '20261225090200_care_shop: already applied';
  end if;
end $$;

create table public.care_items (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  slot text not null check (slot in ('head', 'eyes', 'hands', 'legs', 'pin', 'body', 'prop', 'scene', 'care')),
  tier text not null check (tier in ('wearable', 'prop', 'scene', 'care')),
  price integer not null check (price > 0),
  asset_key text not null,
  mascots text[] not null default array['sprout'],
  active boolean not null default true,
  version integer not null default 1
);
comment on table public.care_items is
  'UI-NEEDS SPROUT-CARE item 2: the global shop catalog, matching components/today/care/shop/catalog.ts.';

create table public.care_inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.care_items(id),
  acquired_at timestamptz not null default now(),
  receipt_id uuid not null,
  primary key (user_id, item_id)
);

create table public.care_equipped (
  user_id uuid primary key references auth.users(id) on delete cascade,
  equipped jsonb not null default '{}'::jsonb,
  rev integer not null default 0,
  updated_at timestamptz not null default now()
);
comment on table public.care_equipped is
  'UI-NEEDS SPROUT-CARE item 2: one row per account; `equipped` is {slot: item_id}, `rev` is '
  'shop-state.ts''s single whole-state optimistic-concurrency token.';

create table public.care_purchase_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  item_id text not null references public.care_items(id),
  price integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, action_id)
);
comment on table public.care_purchase_receipts is
  'UI-NEEDS SPROUT-CARE item 2: one row per purchase action id. Written only by care_purchase.';

alter table public.care_items enable row level security;
create policy care_items_read on public.care_items for select to authenticated using (true);
revoke all on table public.care_items from public, anon, authenticated, service_role;
grant select on table public.care_items to authenticated;
grant select on table public.care_items to service_role;

alter table public.care_inventory enable row level security;
create policy care_inventory_select on public.care_inventory for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_inventory from public, anon, authenticated, service_role;
grant select on table public.care_inventory to authenticated;
grant select, insert on table public.care_inventory to service_role;

alter table public.care_equipped enable row level security;
create policy care_equipped_select on public.care_equipped for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_equipped from public, anon, authenticated, service_role;
grant select on table public.care_equipped to authenticated;
grant select, insert, update on table public.care_equipped to service_role;

alter table public.care_purchase_receipts enable row level security;
create policy care_purchase_receipts_select on public.care_purchase_receipts for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.care_purchase_receipts from public, anon, authenticated, service_role;
grant select on table public.care_purchase_receipts to authenticated;
grant select, insert on table public.care_purchase_receipts to service_role;

insert into public.care_items (id, slot, tier, price, asset_key, mascots) values
  ('leaf-pin', 'pin', 'wearable', 10, '/pet/shop/leaf-pin.webp', array['sprout']),
  ('mittens', 'hands', 'wearable', 20, '/pet/shop/mitten.webp', array['sprout']),
  ('bucket-hat', 'head', 'wearable', 25, '/pet/shop/bucket-hat.webp', array['sprout']),
  ('knitted-hat', 'head', 'wearable', 25, '/pet/shop/knitted-hat.webp', array['sprout']),
  ('glasses', 'eyes', 'wearable', 30, '/pet/shop/glasses.webp', array['sprout']),
  ('sunglasses', 'eyes', 'wearable', 35, '/pet/shop/sunglasses.webp', array['sprout']),
  ('shorts', 'legs', 'wearable', 40, '/pet/shop/shorts.webp', array['sprout']);

-- Atomic debit + grant, idempotent on action_id (a retry answers the first receipt). Returns
-- `{status: applied | existing, receipt: {actionId, itemId, price, balance}}`, or `{status:
-- unknown_item | owned | action_conflict}` / `{status: insufficient, short}` (nothing written).
create function public.care_purchase(p_user_id uuid, p_item_id text, p_action_id uuid,
  p_local_date date, p_zone text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_receipt care_purchase_receipts%rowtype;
  v_item care_items%rowtype;
  v_balance integer;
  v_award care_points_ledger%rowtype;
begin
  perform _sync_assert_caller(p_user_id);
  if p_action_id is null then raise exception 'action_id_required' using errcode = '22023'; end if;
  if p_local_date is null or p_zone is null or char_length(p_zone) = 0 then
    raise exception 'bad_request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':care_points', 0));

  select * into v_receipt from care_purchase_receipts
   where user_id = p_user_id and action_id = p_action_id;
  if found then
    if v_receipt.item_id <> p_item_id then return jsonb_build_object('status', 'action_conflict'); end if;
    select coalesce(sum(delta), 0) into v_balance from care_points_ledger
     where user_id = p_user_id and status = 'settled';
    return jsonb_build_object('status', 'existing', 'receipt', jsonb_build_object(
      'actionId', v_receipt.action_id, 'itemId', v_receipt.item_id, 'price', v_receipt.price,
      'balance', v_balance));
  end if;

  select * into v_item from care_items where id = p_item_id and active;
  if v_item.id is null then return jsonb_build_object('status', 'unknown_item'); end if;
  if exists (select 1 from care_inventory where user_id = p_user_id and item_id = p_item_id) then
    return jsonb_build_object('status', 'owned');
  end if;

  select coalesce(sum(delta), 0) into v_balance from care_points_ledger
   where user_id = p_user_id and status = 'settled';
  if v_balance < v_item.price then
    return jsonb_build_object('status', 'insufficient', 'short', v_item.price - v_balance);
  end if;

  insert into care_purchase_receipts (user_id, action_id, item_id, price)
  values (p_user_id, p_action_id, p_item_id, v_item.price);
  v_award := _care_points_award(p_user_id, 'purchase:' || p_action_id, 'v1', 'purchase',
    -v_item.price, p_local_date, p_zone, 'settled', jsonb_build_object('itemId', p_item_id));
  insert into care_inventory (user_id, item_id, receipt_id) values (p_user_id, p_item_id, p_action_id);

  return jsonb_build_object('status', 'applied', 'receipt', jsonb_build_object(
    'actionId', p_action_id, 'itemId', p_item_id, 'price', v_item.price,
    'balance', v_balance - v_item.price));
end $$;
revoke all on function public.care_purchase(uuid, text, uuid, date, text) from public, anon, authenticated;
grant execute on function public.care_purchase(uuid, text, uuid, date, text) to authenticated, service_role;

-- Wears an owned item in its slot, or clears the slot with a null item id; `p_rev`, when given,
-- must match the account's current rev or the call answers `conflict` with the current state.
-- Returns `{status: ok | conflict | not_owned | wrong_slot, equipped, rev}`.
create function public.care_equip(p_user_id uuid, p_slot text, p_item_id text, p_rev integer)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_row care_equipped%rowtype;
  v_item care_items%rowtype;
  v_next jsonb;
  v_new_rev integer;
begin
  perform _sync_assert_caller(p_user_id);
  if p_slot is null or p_slot not in ('head', 'eyes', 'hands', 'legs', 'pin', 'body', 'prop', 'scene', 'care') then
    raise exception 'bad_slot' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':care_equip', 0));

  insert into care_equipped (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from care_equipped where user_id = p_user_id for update;

  if p_rev is not null and p_rev <> v_row.rev then
    return jsonb_build_object('status', 'conflict', 'equipped', v_row.equipped, 'rev', v_row.rev);
  end if;

  if p_item_id is null then
    if not (v_row.equipped ? p_slot) then
      return jsonb_build_object('status', 'ok', 'equipped', v_row.equipped, 'rev', v_row.rev);
    end if;
    v_next := v_row.equipped - p_slot;
  else
    select * into v_item from care_items where id = p_item_id;
    if v_item.id is null or not exists (
         select 1 from care_inventory where user_id = p_user_id and item_id = p_item_id) then
      return jsonb_build_object('status', 'not_owned', 'equipped', v_row.equipped, 'rev', v_row.rev);
    end if;
    if v_item.slot <> p_slot then
      return jsonb_build_object('status', 'wrong_slot', 'equipped', v_row.equipped, 'rev', v_row.rev);
    end if;
    if v_row.equipped->>p_slot = p_item_id then
      return jsonb_build_object('status', 'ok', 'equipped', v_row.equipped, 'rev', v_row.rev);
    end if;
    v_next := v_row.equipped || jsonb_build_object(p_slot, p_item_id);
  end if;

  update care_equipped set equipped = v_next, rev = v_row.rev + 1, updated_at = now()
   where user_id = p_user_id
  returning equipped, rev into v_next, v_new_rev;
  return jsonb_build_object('status', 'ok', 'equipped', v_next, 'rev', v_new_rev);
end $$;
revoke all on function public.care_equip(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.care_equip(uuid, text, text, integer) to authenticated, service_role;
