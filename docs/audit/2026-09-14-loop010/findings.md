# Loop 010 findings — 2026-09-14

Every finding below was reported by an agent that exercised the surface against a local stack at
production scale, then adversarially verified by a separate agent. The five criticals were then
re-verified by hand before anything was changed — which is how the MCP one was caught as wrong.

## Coverage

| Area | Surfaces tested | Blocked | Findings |
|---|---|---|---|
| body-health | 14 | 1 | 0 |
| catalog-search | 26 | 2 | 3 |
| coach | 13 | 4 | 4 |
| constraints-safety | 9 | 1 | 2 |
| estimator | 13 | 2 | 0 |
| export-mcp | 15 | 5 | 1 |
| foods-tab | 6 | 0 | 1 |
| logging | 12 | 5 | 4 |
| security-rls | 60 | 1 | 1 |
| sync | 11 | 1 | 2 |
| targets-ramp | 7 | 0 | 1 |
| today-plan | 11 | 0 | 1 |
| **total** | **197** | **22** | **20** |

A blocked surface is NOT a pass. 22 were blocked, mostly by cron-secret and MCP-token setup in
this environment rather than by product defects.

## Findings

### [critical] F-055 — Barcode-cached foods are permanently invisible to /api/foods/search, even for an exact phrase + exact brand match
**Status: OPEN** · area: catalog-search

- **Where:** supabase/migrations/20261014090000_barcode_write_category.sql:39-40
- **Repro:** 1) POST /api/foods/barcode {"gtin":"012345678905"} (with cookie jar) -> 200, resolved, cached:false, catalogFoodId 13702, description "Sphère plaisir", brand "Alteña's Nopales". 2) GET /api/foods/search?q=Sph%C3%A8re%20plaisir&brand=Alte%C3%B1a%27s%20Nopales -> {"hits":[]}. Reproduced again with a second scanned barcode (999999999993 -> "Turkey Gouda On Ciabatta", brand "Granato Gourmet market"): GET /api/foods/search?q=Turkey%20Gouda%20On%20Ciabatta&brand=Granato%20Gourmet%20market returns only unrelated generic USDA turkey rows, never the scanned item. Root cause confirmed in the DB: catalog_write_provider_revision (supabase/migrations/20261014090000_barcode_write_category.sql:39-40, uncha
- **Observed:** A food that was just resolved via barcode scan, and whose own description+brand were typed back verbatim, returns zero search hits (or only unrelated generic USDA rows).
- **Expected:** Per F-055's acceptance criterion, 'An exact GTIN or exact phrase-plus-brand match scores 1 and ranks first.' A barcode-cached item should be a search candidate at all; instead it can never be found by name once scanned, defeating the purpose of caching it (F-052) and meaning any later re-lookup by typed name (manual search, or an AI-grounding tool like F-094's search_foods) will silently miss it and likely create a duplicate catalog row on the next scan/fetch.

### [critical] F-076 — PUT /api/constraints lets a padded allergen string silently disable the gluten/dairy/apple floor, defeating evaluatePolicy for search, food detail, and the actual log-commit write path
**Status: FIXED** · area: constraints-safety

- **Where:** lib/server/constraints.ts:50-53 (missingFloorAllergen trims+lowercases only for the check), lib/coach/types.ts:68 (constraintsPutSchema has no trim/normalize on avoidAllergens strings), lib/policy/constraints.ts:38-39 (evaluatePolicy does an exact lowercase-only match, no trim); also reachable via lib/mcp/coach-tools.ts:49-53 (set_constraints MCP tool calls the identical putProfile)
- **Repro:** 1) curl -b $COOKIES http://localhost:3000/api/constraints -> baseline {avoid_allergens:[gluten,dairy,apple], rev:0}.
2) curl -b $COOKIES -X PUT http://localhost:3000/api/constraints -H 'content-type: application/json' -d '{"baseRev":0,"avoidAllergens":["gluten ","dairy","apple"]}' (note the trailing space after gluten) -> HTTP 200 {"status":"ok", avoid_allergens:["gluten ","dairy","apple"], rev:1} -- stored verbatim, untrimmed.
3) curl -b $COOKIES http://localhost:3000/api/foods/13702 (a real catalog item whose catalog_ingredients.allergen_tags = {eggs,gluten,mustard,sulphur-dioxide-and-sulphites}) -> policy.verdict = "allowed".
4) POST /api/log/commit referencing that item's food_ref_id (vi
- **Observed:** The server's own floor check (missingFloorAllergen) validates a trimmed+lowercased copy of the submitted array but stores the raw value, so "gluten " (trailing space) satisfies the 422 floor_violation guard yet never equals "gluten" in evaluatePolicy's later exact match. The result: a single PUT with one padded string turns off gluten blocking everywhere the profile is consulted -- catalog search, food detail, AND the real /api/log/commit write path that actually persists entries -- while the UI's locked pill and the tool's own description ("gluten, dairy and apple can never be removed from avoidAllergens", lib/mcp/coach-tools.ts:47) both claim this is impossible.
- **Expected:** Per F-076/F-077 and the code's own stated invariant (lib/server/constraints.ts:17 "gluten, dairy and apple never leave the list"), any write that would leave the effective avoid_allergens set without a case/whitespace-normalized gluten/dairy/apple entry should be rejected with 422 floor_violation, and evaluatePolicy's matching should be robust to incidental whitespace so a stored value can never accidentally stop protecting her.

### [critical] - — A second device's duplicate_groups create op silently reverts and corrupts an already-merged group instead of converging cleanly
**Status: FIXED** · area: sync

- **Where:** supabase/migrations/20261014090001_fix_duplicate_groups_fingerprint_conflict.sql:169-187 (and supabase/migrations/20260911000600_rpc.sql:293-383 apply_sync_op)
- **Repro:** Against POST /api/sync/ops (real signed-in session): (1) create duplicate_groups id=GA fingerprint=FP state=open -> applied rev=1. (2) update GA base_rev=1 payload {state:'merged', merged_into_entry_id:<a real log_entries id>} -> applied rev=2; verified in DB: state=merged, merged_into_entry_id set, rev=2. (3) simulate a second device independently detecting the SAME real-world duplicate: create op with a FRESH id=GB, SAME fingerprint FP, payload {state:'open'} (no merged_into_entry_id) -> server answers {status:'applied', rev:1, seq:N}. Actual run: GA=036c8975-1cd0-45f3-ab21-9483bc084495, GB=a26403a6-4343-4b2e-80ea-c2754bc79e02, fingerprint=cd*32 hex.
- **Observed:** The response claims a new row was created ({status:'applied', rev:1}), but `select count(*) from duplicate_groups where id=GB` is 0 — no row was ever created at GB. Instead the EXISTING merged row (GA) was silently overwritten: `state` reverted from 'merged' back to 'open', `merged_into_entry_id` was wiped to NULL, and `rev` regressed from 2 to 1 (verified via docker psql before/after). The change_log row inserted for this op has entity_key=GB, op='create', rev=1, and current=NULL. GET /api/sync/changes?since=<prev> confirms the wire payload: {"entity_key":"a26403a6-...","op":"create","current":null}. lib/sync/client.ts:93 treats any change.current===null (for a non-user_settings entity) as 
- **Expected:** Per architecture.md §3.7 and the migration's own stated intent ('two devices independently detecting the same real-world duplicate ... converges onto the first device's row instead of raising a raw unique_violation'), a second device's create for an already-existing fingerprint should converge onto the existing row without destroying its state: it must not silently revert an already-decided 'merged'/'dismissed' group back to 'open', must not wipe merged_into_entry_id, must not regress rev, and c

### [critical] F-093 — Opening any existing coach thread 500s on the default (no `before`) load every client actually makes
**Status: FIXED** · area: coach

- **Where:** app/api/coach/threads/[id]/route.ts:31,41
- **Repro:** Sign in, then: curl -b $COOKIES 'http://localhost:3000/api/coach/threads/<id>' (no ?before= — exactly what lib/coach-client.ts:104-107 sends whenever CoachChat.tsx opens a thread). Confirmed the same request with an explicit ?before=2147483647 (int4 max) returns 200, and ?before=2147483648 (int4 max+1) reproduces the same 500.
- **Observed:** HTTP 500 {"error":"internal","message":"Could not read the transcript."} for every thread that has messages.
- **Expected:** 200 with {thread, messages} — the same payload returned when an explicit small `before` is supplied. Route doc comment: 'GET returns { thread, messages } paged by ?before=<seq>&limit=50'.

### [critical] F-041 — 7 of 8 core MCP tools (list_foods, add_food, set_food_status, get_day, log_gut, search_foods, log_food) crash on every call with an opaque "[object Object]" error
**Status: RECLASSIFIED** · area: export-mcp

- **Where:** app/api/mcp/route.ts
- **Repro:** curl -X POST http://localhost:3000/api/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer <valid api_tokens row with scope read>' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_day","arguments":{"date":"2026-09-14"}}}'  (also reproduced for list_foods, search_foods, add_food, log_gut with valid tokens/args and every date I tried, including no date/today)
- **Observed:** HTTP 200, body: {"result":{"content":[{"type":"text","text":"[object Object]"}],"isError":true},...}. Root cause traced end to end: every tool in LEGACY_STORE_TOOLS (app/api/mcp/route.ts:356-358) calls pullAll()/pushRecords() in lib/server/db.ts, which queries the plain `foods`, `days`, `settings` tables (lib/server/db.ts:44-52, e.g. `db().from("foods").select(...)`). None of these three tables exist anywhere in this repo's schema — `grep -n "^create table" supabase/migrations/*.sql` never creates them, and `select table_name from information_schema.tables where table_name in ('foods','days','settings')` against the local DB returns zero rows. The resulting PostgREST error comes back as a *p
- **Expected:** Per F-041's acceptance ('An MCP client with the correct token can list and call every registered tool') and F-042's acceptance ('The Today screen and an MCP get_day call for the same date return the same slots and totals'), these tools should return real data (get_day should match what the Today screen shows for the same date). Instead the entire food-list/day/gut-logging surface of the MCP server is non-functional for any real client (e.g. Sasha's coach agent) — only the newer per-user tools (g

### [high] F-076 — The simple_sugars banned-category rule is never enforced on catalog search or the log-commit write path -- only 'unverified', never 'blocked', so honey/syrup/jam sail through her primary food-logging flow
**Status: OPEN** · area: constraints-safety

- **Where:** lib/server/catalog.ts:163-170 (searchFoods hardcodes category: null in every hit's evaluatePolicy call), lib/server/log.ts:416-421 (evidenceForItems hardcodes category: null for every commit item, with a comment stating category is 'not evidence the commit path has'), lib/policy/constraints.ts:17-21 (DEFAULT_PROFILE.banned_categories = ["simple_sugars"])
- **Repro:** 1) curl -b $COOKIES 'http://localhost:3000/api/foods/search?q=honey&limit=5' -> every hit (including catalog_food_id 2605, description "Honey", USDA category "Sweets", no allergen tags) returns policy.verdict = "unverified" -- never "blocked", and no category signal appears at all.
2) Resolved a food_ref for catalog_food_id 2605 via get_or_create_food_ref and POSTed it to /api/log/commit -> {"status":"ok"}, the entry committed successfully. Cleaned up the test log_entries/log_items row afterward.
- **Observed:** USDA's own category taxonomy for the bulk-imported 13,700-item catalog (e.g. "Sweets", verified via `select distinct category from catalog_food_revisions`) never equals the app's internal banned_categories value "simple_sugars" -- that keyword-derived category (lib/catalog/off-map.ts's deriveCategory) is only ever computed for OFF/FDC-branded barcode-scan imports, never applied to the bulk USDA catalog that ordinary text search uses. On top of that, even where a food IS tagged simple_sugars, lib/server/log.ts's evidenceForItems never passes category evidence at commit time at all, so banned_categories can never block a real commit through that path (only allergen tags and avoid_food_ref_ids 
- **Expected:** AGENTS.md states the coach removed honey, syrups, sugar, agave and jam from her plan on 2026-09-09 specifically to keep them off her list, and F-076/F-077 name banned_categories as an enforced part of the deterministic constraint policy. Searching for or logging a known simple-sugar catalog item should surface a 'blocked: category:simple_sugars' verdict (as lib/server/barcode.ts:100 now correctly does for the barcode-scan path, since the 2026-09-13 audit's finding #33 was fixed there) instead of

### [high] - — duplicate_groups rows created by the real logging path never enter the change_log, so they are invisible to GET /api/sync/changes on every device
**Status: OPEN** · area: sync

- **Where:** lib/server/log.ts:271-295 (recordFingerprint, called from applyLogEntry / POST /api/log/commit)
- **Repro:** Inspected the local DB directly: `select id, created_at from duplicate_groups where user_id='15fcca57-244e-4476-92ba-19482aaa47e6'` shows a row (id=d0d0aeb9-0146-4d45-b6ea-937d90be85aa) created at 2026-09-14 16:11:07 by ordinary /api/log/commit traffic (well before any of my manual /api/sync/ops calls). `select seq from change_log where user_id='15fcca57-...' and entity='duplicate_groups' and entity_key='d0d0aeb9-0146-4d45-b6ea-937d90be85aa'` returns zero rows.
- **Observed:** recordFingerprint() (lib/server/log.ts:271) creates the group with a plain `client.from('duplicate_groups').insert(...)` (and `duplicate_group_members` insert) -- it never calls next_change_seq or inserts into change_log the way apply_sync_op does for every other write. The row exists in Postgres but is permanently absent from the change feed: any device, including the one that just logged the duplicate meal, calling GET /api/sync/changes will never see this duplicate_groups entity_key appear, at any `since` cursor, ever.
- **Expected:** architecture.md §3.7 states plainly: 'Group state syncs like any other entity, so a decision on the phone does not reappear on the laptop,' and describes the change feed (`GET /api/sync/changes`) as the only read path for synced entities (`current` makes the feed self-sufficient ... there is no separate fetch-by-id endpoint). A duplicate_groups row created by the log-commit fingerprint check should be recorded through the same next_change_seq/change_log path as every other sync write, so any dev

### [high] F-093 — A primary-model failure ends the coach turn with a 503, not a continued conversation on a fallback model
**Status: OPEN** · area: coach

- **Where:** lib/ai/route.ts:36-42 (routeFor — one RouteTarget, no second provider); lib/server/coach.ts:334-349
- **Repro:** POST /api/coach {"threadId":null,"messageId":"<uuid>","text":"Can I have a bagel with cream cheese and a sliced apple for meal 1?"}. Server log: 'coach generation failed { provider: google, modelId: gemini-3.6-flash, error: AbortError the provider did not answer within 20000ms }', request took 70s.
- **Observed:** HTTP response {"error":"coach_unavailable","message":"The coach is unavailable right now. Try again in a minute."}. No fallback provider/model exists anywhere in lib/ai/route.ts for the coach purpose — the adapter only retries the same gemini-3.6-flash model 3 times (lib/ai/adapter.ts:53,374).
- **Expected:** docs/features.md F-093 acceptance: 'A coach conversation continues on the fallback model if the primary model call fails.'

### [high] F-093 — A failed turn leaves a permanent, empty, unreachable coach thread in her thread list
**Status: OPEN** · area: coach

- **Where:** lib/server/coach.ts:264 (ensureThread creates the row) vs :346 (503 thrown before any persist())
- **Repro:** Same request as above (bagel/cream cheese/apple, threadId: null). After the 503: docker exec supabase_db_meal-companion psql ... "select id,title,last_message_at from coach_threads where id='3f49270f-23a1-4f5a-8010-adfee6e1ecd5'" and "select count(*) from coach_messages where thread_id=..." ; also GET /api/coach/threads (list) as the same user.
- **Observed:** coach_threads row exists with last_message_at NULL and 0 rows in coach_messages, and it appears in GET /api/coach/threads with her literal question as its title — but the failed POST response never returned a threadId, so the client has no way to resume or identify it. (Confirmed the only recovery is DELETE /api/coach/threads/<id>, which does work.)
- **Expected:** A failed turn should not leave a permanent, message-less thread visible in her history, or the client should at least receive the threadId so the retry reuses it instead of orphaning it.

### [high] F-021 — Reactivating an avoided seed/preset food through "Add a food" silently wipes its saved note
**Status: FIXED** · area: foods-tab

- **Where:** components/AddFoodSheet.tsx:116-119,276
- **Repro:** 1) Foods tab → tap a seed/preset food, e.g. "Chicken breast, cooked" → type note "hurt on 9/12" → "I can't eat this right now" (confirmed live in browser: Avoid tab shows "Chicken breast, cooked" struck through with the note "hurt on 9/12"). 2) Tap "Add a food" → search "chicken". AddFoodSheet's own candidate filter (`[...PRESET_FOODS, ...SEED_FOODS].filter(f => !existing[f.id] || existing[f.id].status === "avoid")`, AddFoodSheet.tsx:116-119) means every food that ever shows up in this list, if it's already in her food map, is by construction currently on Avoid — so the avoided "Chicken breast, cooked" is listed and tappable. 3) Tap it: the onClick handler (AddFoodSheet.tsx:276) calls `onAdd
- **Observed:** After the re-add tap, the food record is `{..., status: "eats", updatedAt: <now>}` with no `note` field at all — the "hurt on 9/12" note is gone. Confirmed by running the exact onClick → onAdd → upsertFood chain from the real source files: `NOTE SURVIVED: false`.
- **Expected:** Per AGENTS.md ("nothing is ever deleted... 'avoid' keeps the note ... so she can bring it back") and F-021's acceptance ("Reactivating a previously-avoided food restores its original note"), bringing the food back should preserve the note. It does when she uses FoodSheet's own "Bring it back" button (which only ever flips `status`, never rebuilds the record) — but "Add a food" is the app's other, equally reachable way to bring back exactly this class of food (its own filter re-lists every avoide

### [high] F-009 — Per-slot time edit has no long-press UI on Today, and the Settings substitute changes a slot's time on every date of every day type at once
**Status: OPEN** · area: today-plan

- **Where:** components/SlotCard.tsx (no long-press handler exists); components/ShiftTimes.tsx:8-17 (the global, un-scoped `slotTimes` field that stands in for it, with its own comment admitting the cross-day-type bleed); lib/types.ts Settings.slotTimes (Partial<Record<SlotId,string>>, keyed only by slot id, not by date or day type)
- **Repro:** 1) Load /settings, find 'One slot's own time', set the 'Meal 1 time' field to 10:15. 2) Load /?d=2026-11-12 (a Thursday training day never touched before) -> Meal 1 shows 10:15 am instead of its base 11:30 am. 3) Load /?d=2026-11-15 (a Sunday rest day, different day type, never touched) -> Meal 1 ALSO shows 10:15 am instead of its base 11:00 am. 4) Inspect components/SlotCard.tsx (the Today-screen slot card) and app/page.tsx: there is no press/hold/context-menu handler anywhere in the slot-card render chain (confirmed by reading the full file and grepping the repo for long-press/pointer-hold patterns).
- **Observed:** The Today screen's slot cards have no long-press gesture at all. The only place to set a slot's own time is a plain <input type=time> per slot id in Settings > 'One slot's own time', and that one value applies to every date, of every day type, that has a slot with that id -- a single edit intended for one day silently moves the same slot on every other day (including a different day type with a different base time), forever, until manually cleared.
- **Expected:** docs/features.md F-009: 'Long-pressing a slot lets her set that slot's own time, overriding the default' with acceptance 'Long-press on a slot opens a time editor and the new time persists after reload' -- i.e. a per-slot override reachable by long-pressing the slot card on the Today screen, implicitly scoped to the day being viewed. Instead there is no long-press interaction anywhere, and the actual override is a global, cross-day-type setting a user would have no reason to expect changes days 

### [high] F-041 — MCP legacy-store tools (list_foods, add_food, set_food_status, get_day, log_gut) crash even for the one authorized user, because the tables they query were never created
**Status: RECLASSIFIED** · area: security-rls

- **Where:** lib/server/db.ts:46
- **Repro:** 1) Seed a valid api_tokens row for the SASHA_USER_ID identity (local DB): insert into api_tokens (id,label,user_id,token_hash,scopes) values ('66666666-6666-6666-6666-666666666666','qa-test-u1', <SASHA_USER_ID>, sha256('smc_qatest_user1'), array['read']). 2) POST http://localhost:3000/api/mcp with header Authorization: Bearer smc_qatest_user1 and body {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_foods","arguments":{"status":"eats"}}} (also tried name=get_day and name=log_gut). 3) Independently confirmed the cause: `docker exec supabase_db_meal-companion psql -c "select count(*) from foods;"` -> `ERROR: relation "foods" does not exist`; grep -rn "create table foods\|cr
- **Observed:** HTTP 200 with a JSON-RPC error envelope: {"result":{"content":[{"type":"text","text":"[object Object]"}],"isError":true}} for list_foods and for get_day (same for log_gut/add_food by code inspection, all sharing the same pullAll()/pushRecords() call). Only the `rules` tool, which returns a static string with no DB access, succeeds. The identity/scope layer itself is correct — a token for a different user gets a clean 404 ("No data for this user.") from the SASHA_USER_ID guard in app/api/mcp/route.ts, and a read-only token correctly gets 403 on add_food ("Token lacks the \"log:write\" scope.") — the defect is purely that pullAll()/pushRecords() (lib/server/db.ts:46-51, called from app/api/mcp
- **Expected:** Per F-041's acceptance criterion, 'An MCP client with the correct token can list and call every registered tool,' and per F-047, a per-user token scoped to the right identity should be able to use the tools MCP advertises (list_foods, add_food, set_food_status, get_day, log_gut, rules) rather than getting an opaque isError for 5 of the 6.

### [high] F-029 — Server-side constraint policy BLOCKS an allergen-tagged log instead of flagging it, contradicting the app's own "marking, never hiding" logging rule
**Status: OPEN** · area: logging

- **Where:** lib/server/log.ts:424-453 (policyIssues/checkLabelAndPolicy) and lib/policy/constraints.ts:36-59 (evaluatePolicy)
- **Repro:** POST /api/log/commit (signed-in session) with a label-scan body naming an explicit dairy allergen tag:
{"entry_id":"<uuid>","eaten_at":"2026-09-14T18:30:00-04:00","tz":"America/New_York","local_date":"2026-09-14","slot":"meal-2","method":"label","draft_id":"<uuid>","save_label_as_food":true,"items":[{"id":"<uuid>","seq":0,"food_ref_id":"00000000-0000-4000-8000-000000000000","qty":1,"unit":"g","grams":200}],"label_food":{"name":"QA Test Yogurt Cup","per100g":{...20 nutrient codes...},"ingredientsText":"cultured milk, live active cultures","allergenTags":["dairy"]}}
- **Observed:** HTTP 200 body {"status":"invalid","issues":[{"path":"items.0","message":"blocked:allergen:dairy"}]}. Verified via DB that nothing was written: `select count(*) from log_entries where id=...` = 0 and `select count(*) from user_foods where name='QA Test Yogurt Cup'` = 0. The item is refused outright, not logged with a flag.
- **Expected:** docs/features.md F-029 acceptance: "Logging a dairy item shows a visible flag on that entry without preventing the log." This matches the explicit 2026-09-13 audit ruling R6 in docs/decisions/2026-09-12-session-rulings.md ("Logging stays 'marking, never hiding'") and the client's own copy in components/LogFoodSheet.tsx's offPlanLine ("Off-plan: dairy... Logging it is still the right call."). Instead, any item for which the server has real allergen evidence (a label-scanned food's own allergenTag

### [high] F-066 — AI-capture auto-resolve threshold (0.95) is unreachable given the real search scoring, so /api/log/propose never grounds an item — reproduced with the acceptance criterion's own example
**Status: OPEN** · area: logging

- **Where:** lib/search/thresholds.ts:11-14 (AUTO_RESOLVE minScore 0.95) and lib/capture/grounding.ts:1-9 (shouldAutoResolve caller)
- **Repro:** POST /api/log/propose {"method":"text","text":"two eggs and a cup of rice","slot":"meal-1","tz":"America/New_York","localDate":"2026-09-14"} — the exact sentence named in F-066's acceptance text. Root-cause check: GET /api/foods/search?q=Chicken%2C%20breast%2C%20boneless%2C%20skinless%2C%20raw (the VERBATIM full description of an existing catalog row) and GET /api/foods/search?q=rice.
- **Observed:** The propose draft returns both items with foodRefId:null and autoResolved:false (per docs/specs/phase-4-ai-capture.md:120, foodRefId:null means "ungrounded"). Root cause confirmed directly: searching the food's own exact, complete name only scores 0.5485 (top hit), and a plain "rice" search never surfaces catalog id 6 "White rice, cooked" at all in the top 25 results (dominated by unrelated compounds like "Rice milk"/"Rice cake" at the same or higher score). Since even a perfect string match tops out well under 0.55, and AUTO_RESOLVE.generic.minScore is 0.95, no query can ever pass shouldAutoResolve. The grounding.ts file even carries its own comment acknowledging this: "with today's thresho
- **Expected:** F-066 acceptance: "Typing 'two eggs and a cup of rice' produces a draft with two grounded catalog items." Every text/voice/label/photo capture (F-066-F-069) and the ≥90% auto-resolve precision gate (F-070) depend on this same threshold, so this single miscalibration means the entire AI-capture feature set currently always falls back to full manual disambiguation for the user, regardless of how obvious the match is.

### [high] F-089 — Saving a manually authored 'Targets — grams or percent' profile never changes what Sasha is actually served
**Status: OPEN** · area: targets-ramp

- **Where:** lib/resolve.ts:60-80
- **Repro:** 1) Sign in, then POST a valid, floor-clear target profile: curl -s -b $COOKIES -X POST http://localhost:3000/api/targets -H 'Content-Type: application/json' -d '{"mode":"percent","effectiveFrom":"2026-09-14","kcalTrain":2200,"kcalRest":1750,"percent":{"proteinPct":28,"fatPct":30,"carbPct":42}}'  (returns 200, resolved training 2200 kcal/154P/232C/73F). 2) curl -s -b $COOKIES http://localhost:3000/api/targets confirms this profile — not the ramp — is now 'active' (id is the new profile's UUID). 3) In a real browser session for the same signed-in user, load the Today screen (GET /).
- **Observed:** The server (GET /api/targets, backed by target_profiles + activeProfile()/activeTargets() in lib/server/targets.ts) reports the newly authored profile as the fully active target with no separate approval step — the sheet's own Save button commits it as effective from today (components/TargetModeSheet.tsx: effectiveFrom defaults to `today` and Save calls onSave directly). Yet the Today screen's rings and every meal's portion sizing still show the OLD ramp/pin numbers (observed: 'OF 1,310 KCAL' / 'OF 115 G PROTEIN' / 'OF 100 G CARBS' / 'OF 50 G FAT', matching only the local ramp+pin state, not the 2200/154/232/73 the server now calls active). The Settings screen's own 'What she'll actually eat
- **Expected:** Per the app's own design intent (lib/server/targets.ts's comment: 'activeTargets returning null means... the ramp outranks the engine' — implying a non-null active profile should outrank the ramp) and F-088's acceptance framing ('an unapproved proposal never changes the displayed daily target', implying an approved/authored one does), saving a valid, floor-clear grams-or-percent target through Settings should update Sasha's actual daily targets — the Today screen's rings and meal portions, and t

### [medium] F-093 — Coach replies leak raw prompt/schema fragments into the chat text; the degeneration guard doesn't catch short leaks
**Status: OPEN** · area: coach

- **Where:** lib/coach/turn.ts:183-200 (sanitiseReply only intervenes at >=6 sentences and only on an exact repeated sentence)
- **Repro:** POST /api/coach 'I want a snack with cheddar cheese in it, what do you suggest?' and separately 'Search the food database for pizza and tell me if I'm allowed to have it.' (2 of my 3 live coach model calls hit this.)
- **Observed:** Assistant content: "Dairy is on your constraint list, so I cannot suggest options containing it. Would you like pumpkin seeds instead? baseline=" and, in the second case: "...Do you want me to search for gluten-free and dairy-free options? suggestions are strictly blocked. suggestions: []" — trailing fragments that read as leaked internal field names/instructions, not natural language.
- **Expected:** A clean, complete natural-language reply with no stray schema/placeholder tokens reaching the user, per the same reply-degeneration concern already fixed for the long-form case in docs/audit/2026-09-13/coach-rca.md RC5 (that fix only handles exact-repeat runs at 6+ sentences, not this shorter leaked-fragment form).

### [medium] F-028 — Water log "correction" (decrement) is silently discarded by the server; a self-correction reports success but the count snaps back on the next sync/reload
**Status: FIXED** · area: logging

- **Where:** supabase/migrations/20261014090001_fix_duplicate_groups_fingerprint_conflict.sql:83-89 (`on conflict ... set cups = greatest(water_log.cups, excluded.cups)`), lib/water-client.ts addCups (negative-delta "her own correction" path), components/WaterCard.tsx (Remove-a-cup stepper)
- **Repro:** In a real signed-in browser session: tap "+" on the Water card three times (cups=4 confirmed via DB), then tap "−" once (the WaterCard minus stepper, components/WaterCard.tsx onMinus -> addCups(date,-1)). Also reproduced directly via POST /api/sync/ops with {entity:'water_log', kind:'update', base_rev:<current>, payload:{local_date, cups: current-1}}.
- **Observed:** The UI immediately shows the lower count (3 cups) and the sync op returns {"status":"applied",...} with rev incremented. But `select cups from water_log where local_date=...` on the server stays at the prior higher value (4) the whole time. Reloading the page (a fresh pull from the server) reverts the UI back to "4 cups · 32 oz" — the correction is gone with no error ever shown to her. The DB migration's on-conflict clause applies `greatest()` unconditionally for every write (create AND update, regardless of a matching base_rev), so a decrease can never actually persist through this path.
- **Expected:** lib/water-client.ts's own comment documents the intended behavior for a negative delta: "her own correction, applied as she asked." A rev-correct update that intentionally lowers the day's cup count should persist that lower value, not be silently clamped back up while reporting success.

### [medium] F-030 — Notes added to an already-logged food/meal ("Also today") are never sent to the server — local-only, unlike plan-slot notes which do sync
**Status: OPEN** · area: logging

- **Where:** app/page.tsx:312-315 (noteEntry -> updateExtra) and lib/store.ts:213-215 (updateExtra, pure localStorage) vs. lib/plan-day-client.ts:118-138 (saveSlotNote, properly wired through enqueueWithRow to the plan_days sync entity)
- **Repro:** In a real signed-in browser session: logged "Chicken, breast, boneless, skinless, raw" via the Log-a-food sheet (confirmed via network log: POST /api/log/commit -> 200), then tapped "Add note" on that entry in "Also today", typed "QA sync-check note", and tapped "Save note". Captured the tab's network requests before and after the save, and queried the DB for that entry's note column.
- **Observed:** The network request list (read_network_requests) shows the exact same 477 total requests, byte-for-byte identical to before the save — no fetch of any kind fires when the note is saved. `select note from log_entries where id in (...)` for the two just-logged chicken entries returns empty/null for both, even though the UI (and a same-browser page reload) both show "QA sync-check note" on the entry. The note lives only in that browser's `localStorage` (lib/store.ts's `days[date].extras`), which the new Supabase-backed log_entries/log_items tables and the MCP `get_day` tool never see.
- **Expected:** F-030: "Any logged extra or any plan slot can carry a note she edits later." The server itself already supports persisting an updated note on an existing entry (verified separately: re-POSTing /api/log/commit with base_rev and a new `note` field does update log_entries.note), so this is a UI wiring gap, not a missing capability — but as shipped, a note on a real logged food is invisible to any other device, to the MCP tool, and is permanently lost if that browser's site data is ever cleared, unl

### [low] - — GET /api/foods/[id] ignores catalog_versions.is_active while search requires it, so detail-by-id and search disagree on which foods 'exist'
**Status: OPEN** · area: catalog-search

- **Where:** lib/server/catalog.ts:216-221
- **Repro:** GET /api/foods/13702 (the same barcode-cached, version-inactive food from finding 1) -> 200 OK with full detail, while GET /api/foods/search for the same food's exact name+brand returns zero hits.
- **Observed:** getFoodDetail's query only filters on catalog_food_revisions.is_active, with no join to catalog_versions.is_active, so a food whose whole catalog_versions row is inactive is still fully readable by id.
- **Expected:** The two read paths should agree on whether a food is part of the 'active catalog' — either both should honor catalog_versions.is_active, or (per finding 1) search should not require it either. As-is, a food can be fetched and logged by id but never discovered by search, which is confusing rather than a deliberate two-tier design (no code comment or spec calls this out).

### [low] - — A whitespace-only query is accepted (200, empty hits) while an empty-string query is rejected (400)
**Status: OPEN** · area: catalog-search

- **Where:** app/api/foods/search/route.ts:15
- **Repro:** curl --get --data-urlencode "q=" http://localhost:3000/api/foods/search -> 400 {"error":"bad_request",...}. curl --get --data-urlencode "q=   " (3 spaces) http://localhost:3000/api/foods/search -> 200 {"hits":[],"queryClass":"generic","autoResolve":null,"catalogVersion":"2026-09-12"}.
- **Observed:** The Zod schema's `z.string().min(1)` treats a 3-character whitespace string as valid (non-empty), but parseQuery() then trims it to an effectively empty query before it reaches Postgres, silently producing an always-empty result set instead of the same 400 the truly-empty string gets.
- **Expected:** Consistent handling of 'no real search text': either both should 400, or both should return an empty-hits 200. The current split behavior is minor (both are harmless dead ends for the user) but is an inconsistency in the input contract.

