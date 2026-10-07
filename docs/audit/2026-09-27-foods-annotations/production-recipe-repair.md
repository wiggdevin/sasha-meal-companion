# Production recipe identity repair and dietary evidence

Root ran the reviewed guarded append-only repair against `fivatgdpuenszxxnijpc` after the production backup recorded in production-migrations-applied.md. Explicit production project confirmation was required. No account meal/history rows were changed.

Preflight:62ingredients,59unmapped,3already mapped,12repairable recipes,29exact USDA source identities present,25missing shared catalog refs. Applied:12new recipe revisions,25refs created,147row writes. Post-read:12roots,24total revisions,0current unmapped ingredients. Original revision1 ingredient MD5 remained `230af098e95bf1a20eea8d89c4688b2c` before/after; old sealed content preserved.

Warmer uses only29reviewed public USDA foods, existing Jev evidence lifecycle and the owner's approved accounting account. Dry run725unknown judgments. Applied725judgments,725writes,0errors,0unknown/retryableUnknown. Allergen evidence319rows,0errors; coverage4/29foods (0.138). Unknown/absent allergen evidence is not converted to absence; no recipe is newly claimed allergen-free merely by this warm.

Commands used `node --env-file` for existing private production configuration, explicit `SUPABASE_PROJECT_REF`, and the verified repository scripts. Secret values never entered argv, logs or repository files. App deployment and signed-in smoke remain separate gates.

Repeated post-write dry run exit0:124historical/current ingredient rows checked,62current already mapped,0repairable recipes/items,0missing identities/refs,0writes. Current repair is idempotent without rewriting old versions.
