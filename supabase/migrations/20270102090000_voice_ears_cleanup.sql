-- Phase 14 voice agent retired (owner, 2026-10-08; docs/specs/phase-14-voice-agent.md). Only
-- slice 1 (the live-dictation minute ledger, 20261117090000_voice_ears.sql) ever landed, and
-- Gemini Live dictation itself was retired before slices 2-5 (brain, mouth, barge-in) were built
-- (lib/voice/dictation-io.ts). Nothing reads or writes voice_ears or its three functions anymore
-- (grepped across lib/, app/, scripts/, tests/ and every other migration: only the original
-- migration, this cleanup, the down pair, the tenancy fixtures/manifest and the phase-14 spec
-- itself still name them). This drops the dead objects; nothing else used this table.
set local lock_timeout = '3s';

drop function if exists voice_ears_refuse(uuid, uuid);
drop function if exists voice_ears_close(uuid, uuid);
drop function if exists voice_ears_open(uuid, integer, integer);
drop table if exists voice_ears;
