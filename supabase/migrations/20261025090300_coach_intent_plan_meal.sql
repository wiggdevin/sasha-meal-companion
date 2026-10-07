-- Landing 2 (meals): the coach routes "plan a meal on a day/range" turns through the new
-- `plan_meal` intent. The telemetry row for such a turn was rejected by the intent CHECK
-- (PostgreSQL 23514) because the list predates the intent. Extend the list; nothing else changes.

alter table coach_intent_events drop constraint if exists coach_intent_events_intent_check;
alter table coach_intent_events add constraint coach_intent_events_intent_check check (intent is null or intent in (
  'shift_schedule','log_food','suggest_options','add_to_eats','add_to_avoid',
  'remove_from_eats','remove_from_avoid','log_water','log_weight','update_profile',
  'set_targets','question','other','plan_meal'
));
