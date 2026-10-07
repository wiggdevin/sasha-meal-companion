# Production migration receipt

Root applied the two user-approved Foods migrations to Supabase project `fivatgdpuenszxxnijpc` after exact-hash local clone/working proofs and private production backup. No production test accounts or personal-row edits.

Backup: `/Users/zero-suminc./Backups/supabase/meal-companion/2026-09-28T012244Z-8606a560.sql`,18,400,953bytes,SHA256 `6d561c846a62bc3ea034cd5681a7bdc59cbd6544d1a90cfe40ac8ac4d8b9871c`; existing backup script exit0.

| Migration | Exact source SHA256 | Result |
|---|---|---|
|20261203090000_custom_food_rules|96a025822df37d6c9c2dabdc9467a8c13dedc4fbb08b3ec12a055cd2dad7d5ea|MCP apply success; ledger verified|
|20261204090000_food_note_sync|85686f837109b140124638878c53c97bce43de8faddfcc2162de1637bfcdbc35|MCP apply success; ledger verified|

MCP assigned execution-date ledger versions20260928012351 and20260928012411. Root changed only those exact named ledger rows to the repository's canonical versions, then verified both. Schema reload notification sent.

Production function definitions match locally verified MD5s: `save_food_note=3a7af9a90694e5c346be37fbf6958a36`; `set_food_membership=794da03ad4b2ae2e6d3bad03cf975d9c`. Internal authority table RLS=true; anon/authenticated direct SELECT=false. Authenticated custom_rules UPDATE column privilege=true. Initial aggregate verification mistakenly used the reverse validator name and failed42883; corrected read uses `custom_food_rules_valid`, no migration rerun.

This receipt proves schema application only. Application source/CI/PR/deployment and guarded production recipe append/warm remain separate release steps.
