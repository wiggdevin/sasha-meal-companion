-- Do not erase a completed review or the pending provenance marker by accident.
do $refuse$
begin
  if exists (select 1 from public.constraint_profiles
              where rule_review_required or rule_reviewed_at is not null)
     and coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on' then
    raise exception 'historical_rule_review down: review state exists; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end;
$refuse$;

alter table public.constraint_profiles
  drop column if exists rule_reviewed_at,
  drop column if exists rule_review_required;
