drop function if exists food_membership_contradictions(uuid);
drop function if exists set_food_membership(uuid, text, text, text, bigint);
drop function if exists food_name_norm(text);
drop table if exists food_membership_revisions;
alter table user_foods drop column if exists note;
