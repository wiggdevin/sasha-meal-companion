-- A downgrade cannot discard eaten history. Refuse until snapshot-bearing rows
-- have been preserved by an explicit data migration outside this rollback.
do $$ begin
  if exists (select 1 from public.plan_days as day,
    lateral jsonb_each(day.eaten_slots) as slot(id, mark)
    where slot.mark ? 'consumed') then
    raise exception 'recipe consumed snapshots exist; downgrade would destroy eaten history';
  end if;
end $$;

-- A marker-bearing row also needs migration 3's replay distinction.
do $$ begin
  if exists (select 1 from public.recipe_plan_selections
    where baseline_override ? 'mutationId') or exists (select 1 from public.plan_days as day,
    lateral jsonb_each(day.item_overrides) as slot(id, override)
    where slot.override ? 'mutationId') then
    raise exception 'slot intent markers exist; downgrade would lose replay ordering';
  end if;
end $$;

create or replace function public.plan_day_eaten_slots_valid(value jsonb) returns boolean
  language sql immutable set search_path = public as $$
    select jsonb_typeof(value) = 'object'
      and not exists (
        select 1 from jsonb_each(value) as slot(id, mark)
        where id not in (
          'coffee', 'pouches-pre', 'post-refuel', 'meal-1', 'meal-2', 'meal-3',
          'meal-4', 'meal-5', 'meal-6', 'hot-chocolate'
        )
          or jsonb_typeof(mark) <> 'object'
          or not mark ? 'eaten_at'
          or not mark ? 'changed_at'
          or exists (select 1 from jsonb_object_keys(mark) key
                     where key not in ('eaten_at', 'changed_at'))
          or jsonb_typeof(mark->'changed_at') <> 'string'
          or jsonb_typeof(mark->'eaten_at') not in ('string', 'null')
          or not ((mark->>'changed_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')
          or (mark->>'eaten_at' is not null and not ((mark->>'eaten_at') ~
            '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'))
      );
  $$;

drop function public.recipe_consumed_snapshot_valid(jsonb);

create or replace function public.recipe_plan_supersede_on_day() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_plan_selections s set superseded_at=now(), updated_at=now()
    where s.user_id=new.user_id and s.local_date=new.local_date
      and s.superseded_at is null and
      (new.swaps ? s.slot_id or (new.item_overrides ? s.slot_id and
        coalesce((new.item_overrides->s.slot_id->>'followPlan')::boolean,false)=false))
      and ((new.swaps->s.slot_id) is distinct from s.baseline_swap
        or (new.item_overrides->s.slot_id) is distinct from s.baseline_override);
  return new;
end $$;
revoke all on function public.recipe_plan_supersede_on_day() from public, anon, authenticated;
