-- Drops only what 20260919090000 created.
alter table recipes drop column updated_at;
alter table favorites_meals drop column deleted_at, drop column updated_at, drop column created_at;
alter table favorites_recipes drop column deleted_at, drop column updated_at, drop column created_at, drop column rev;
alter table favorites_foods drop column deleted_at, drop column updated_at, drop column created_at, drop column rev;
