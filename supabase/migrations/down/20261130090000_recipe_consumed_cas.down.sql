-- Keep consumed history and idempotency receipts. An explicit data-preserving
-- archive is required before this RPC can be downgraded.
do $$ begin
  if exists (select 1 from public.recipe_consumed_requests) then
    raise exception 'recipe consumed requests exist; downgrade would lose replay protection';
  end if;
end $$;
drop function public.recipe_log_consumed(uuid,date,text,uuid,integer,numeric);
drop table public.recipe_consumed_requests;
