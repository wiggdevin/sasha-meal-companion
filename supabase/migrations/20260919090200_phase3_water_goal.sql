-- Phase 3 spec open question 3, reconciled by contracts §3: the spec's `user_prefs` table is not
-- created. Phase 0 already owns a per-user settings row, and one integer does not earn a table,
-- a policy pair, an entity_key shape and a merge rule of its own.
alter table user_settings
  add column water_goal_cups integer not null default 8
    check (water_goal_cups between 1 and 30);
