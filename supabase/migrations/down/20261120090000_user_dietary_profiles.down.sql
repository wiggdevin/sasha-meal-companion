-- Rolls back 20261120090000_user_dietary_profiles.sql. Every confirmed profile instance is lost;
-- evaluatePolicy and rankFoods fall back to whatever the legacy-flags synthesis
-- (lib/policy/profiles/legacy-flags.ts) can still derive from user_settings.diet_prefs.flags.
drop table if exists user_dietary_profiles;
