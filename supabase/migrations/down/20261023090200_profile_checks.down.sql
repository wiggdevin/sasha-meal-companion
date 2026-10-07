-- Rollback of 20261023090200_profile_checks.sql. The nullable profile columns and their data stay.
alter table user_settings
  drop constraint if exists user_settings_training_weekdays_valid_check;

alter table user_settings
  drop constraint if exists user_settings_diet_prefs_object_check;
