-- Undo 20261117090000_voice_ears.sql. The ledger holds no user content (seconds and timestamps).
drop function if exists voice_ears_refuse(uuid, uuid);
drop function if exists voice_ears_close(uuid, uuid);
drop function if exists voice_ears_open(uuid, integer, integer);
drop table if exists voice_ears;
