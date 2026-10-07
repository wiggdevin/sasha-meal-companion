# Audit: p9-cross-refs-pr250 round 2 (GPT-6 Sol, codex exec, xhigh, read-only)

Target: `PR #250, branch origin/fix/p9-cross-account-refs (merges #249's fix/p9-sync-rpc-grants; review #249 parts only as they interact). Diff: git diff origin/main...origin/fix/p9-cross-account-refs` · Commit: `0a26e46` · Date: 2026-09-23 01:14 MDT

---

Verdict: SHIP WITH FIXES — 0 BLOCK, 1 FIX, 0 NIT

1. [FIX] An ingest event can be moved to another source owned by the same account after samples reference it. The event trigger checks source ownership ([migration:154](/Users/zero-suminc./projects/clients/Sasha/meal-companion/supabase/migrations/20261103090100_same_owner_references.sql:154)), but source and event agreement is checked only when a sample is written ([migration:173](/Users/zero-suminc./projects/clients/Sasha/meal-companion/supabase/migrations/20261103090100_same_owner_references.sql:173)). The parent trigger fixes `ingest_events.user_id`, not `source_id` ([migration:368](/Users/zero-suminc./projects/clients/Sasha/meal-companion/supabase/migrations/20261103090100_same_owner_references.sql:368)). A service-role update from source S1 to S2 leaves existing samples on S1 while their event names S2. Make the event’s source immutable after insert, or reject the update when linked samples would disagree; test that parent update.