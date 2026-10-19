-- Reverse of 20270107090200_shopping_period_titles.sql. Refuses while any list carries a title,
-- unless app.allow_down_data_loss = on: dropping the column would silently forget those names.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'shopping_periods' and column_name = 'title')
     and exists (select 1 from public.shopping_periods where title is not null) then
    raise exception 'shopping_period_titles down: lists have titles; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;

alter table public.shopping_periods drop constraint if exists shopping_periods_title_check;
alter table public.shopping_periods drop column if exists title;
