-- Run the downs in reverse timestamp order. 20260919090300's _sync_upsert names this column, so
-- down/20260919090300_phase3_sync_entities.down.sql (which restores the Phase 2 _sync_upsert)
-- must run before this file, or every user_settings op breaks.
alter table user_settings drop column water_goal_cups;
