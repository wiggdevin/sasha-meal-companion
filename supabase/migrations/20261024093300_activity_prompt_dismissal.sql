-- Account-scoped snooze for the activity/profile mismatch prompt.
alter table user_settings
  add column activity_prompt_dismissed_until timestamptz;
