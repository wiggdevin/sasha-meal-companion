-- Down for 20261025090300: restore the intent list without plan_meal. Rows already stored with
-- plan_meal would violate the restored constraint, so they are relabelled `other` first.

update coach_intent_events set intent = 'other' where intent = 'plan_meal';
alter table coach_intent_events drop constraint if exists coach_intent_events_intent_check;
alter table coach_intent_events add constraint coach_intent_events_intent_check check (intent is null or intent in (
  'shift_schedule','log_food','suggest_options','add_to_eats','add_to_avoid',
  'remove_from_eats','remove_from_avoid','log_water','log_weight','update_profile',
  'set_targets','question','other'
));
