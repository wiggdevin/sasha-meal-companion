# Program: every FAB path works and is fast, the coach knows what is going on — 2026-09-17

Devin, 2026-09-17: "go through each item on the FAB list … make sure they work well and are
snappy … taking an image of a meal calculates calories and macros, saves the image, logs at the
time the image was taken with the correct description … save it and use the same meal over and
over … save it into recipes … comes up when I swipe for a quick change … same for a label …
the coach has zero context of what is happening, no memory of earlier conversation, cannot add,
move or delete meals … 'I just ate eggs, bacon and avocado at 9 AM … log that' → a visible card
in Today … delete or move any entry by typing … suggest a turkey lettuce wrap … then voice."

This document is the breakdown. Each task below becomes its own spec, its own hidden acceptance
suite, its own PR, and its own folder under `~/Desktop/proof/`.

## What is true today (three read-only recon passes, 2026-09-17)

**Capture (photo, label, food, meal, barcode, voice, text)**
- Provider: Google Gemini `gemini-3.8-flash` for all capture; `gemini-3.6-flash` for the coach.
  No fallback model. **The key is free-tier: 20 requests a day** (`PROGRESS.md:39-49`). Nothing
  can be snappy on that, and the Phase-4 eval gate (F-070) has never passed because of it.
- Plate photo: the model returns items + grams correctly; nutrients come from the catalog row
  the item is grounded to. Grounding needs a 0.95 match score to auto-resolve
  (`lib/search/thresholds.ts`) — the code's own comment: "almost nothing auto-resolves". So
  every item blocks Save until she taps an alternative. That is the "does not calculate" feel.
- Label scan: the model extracts the nutrients correctly, but the commit is wired wrong end to
  end — the client sends `save_label_as_food: true` and never the `label_food` body the server
  requires (`lib/server/log.ts:225-233`, `lib/capture-client.ts:248`). Default path → `invalid`
  → "That did not save. Try again."
- Time: `eaten_at` is the Save tap (`lib/capture-client.ts:225`). EXIF is stripped by the canvas
  resize before upload (`lib/media/resize.ts:33`).
- Image: private bucket `media`, deleted at commit and by a 24 h sweep; never linked to the entry
  (`media_ref: null`, `lib/server/log.ts:89`). This was a deliberate privacy ruling, 2026-09-10.
- Description: the model's own label, read-only on the confirm sheet. No name field.
- Re-use: no "save as recipe", "log again" or favourite-meal path from any logged entry.
  `toggleFavorite("meal")` throws for a row that does not exist. Duplicate fingerprints are
  written on every commit and read by nothing.
- Swap: meal slots offer her Eats foods composed by role; ritual slots offer the authored library.
  Never a recipe, never a past meal. Persisted as `StoredDay.swaps[slot] = mealId`.
- Speed: grounding is a sequential loop (a 5-item plate ≈ 20 serialised DB round trips after the
  model); media is sign → PUT → propose, three sequential hops before the model starts, and the
  server re-downloads the object and re-uploads it to Gemini; no client-side timeout on any
  capture fetch; no optimistic UI; every route is `force-dynamic` (cold starts).
- Barcode is the best-built path (local catalog, 7-day negative cache, offline replay), and the
  production FAB does not show it — `NEXT_PUBLIC_FEATURE_SCAN` is off there (Devin's screenshot).
- Voice: `VoiceCapture.tsx` records ≤ 30 s and sends audio to Gemini for items. Flagged off.
  `audio/webm` is in the client's list but not in the server's accepted types (415 on Android).

**Coach**
- Memory: none. Each turn sends system prompt + tool spec + the one new message
  (`lib/server/coach.ts:324-328`). The prompt's own two-turn clarification example cannot work.
- Context: today's date (server tz, not hers) and the constraint profile. Nothing else is
  injected. No tool reads the plan slots, what is eaten, or today's entries — `get_day` returns
  nutrient totals only. Slot edits are emitted blind.
- Actions (#208): `log_meal`, `add_slot_item`, `remove_slot_item`, `set_slot_item`, `move_slot`,
  Undo. No time field on `log_meal` (lands at the slot's planned time or now). No delete of an
  existing entry, no retime, no snack outside the seven fixed slots, no swap, no recipe.
- Quantities: the model converts "4 slices of bacon" from its own priors — the catalog's
  household portions are not passed to it. Grounding is top-1 catalog hit, no disambiguation.
- Suggestions: free text; a composite like "turkey lettuce wrap" is one name string. "Log this"
  needs the model to have called `draft_log_entry` and still opens a confirm sheet.
- Speed: no streaming; 3 attempts on any failure; 15 s per attempt in a 75 s budget; one model,
  no fallback (open audit finding). Measured 4.2 s simple, 23 s three-call.
- Voice: none. Text composer only.

**Sync and mapping**
- Her Avoid marks live in localStorage and sync as the legacy `foods` map. The op-log entity
  `user_food_prefs`, its merge rule and the server upsert all exist; no client emits the op.
- The policy has no "on avoid list → blocked" branch; every caller collapses `"avoid"` to
  `false`. The coach, search and scanner cannot see her list.
- Categories: `DEFAULT_PROFILE.banned_categories` is `["simple_sugars"]`; no migration ever set
  the other four. And `simple_sugars` only fires on barcode imports — the USDA rows carry USDA's
  own taxonomy (audit ruling 3, open). Switching a category on is a promise the policy cannot
  keep until a category mapping is authored.
- Water: logs to `water_log`; shows nowhere on Today (card unmounted 2026-09-15 at Devin's
  request). The water-corrections migration is not in production.
- Morning weight: writes `weightLb` to the legacy day; Today's header shows the Apple Health
  value, not hers; it never reaches `health_samples` or the estimator.

**Open product rulings that sit on this work** (`docs/audit/2026-09-14-loop010/README.md`)
1. Dairy: refuse or log-with-flag → resolved by `docs/decisions/2026-09-14-logging-marks-never-refuses.md`.
2. Barcode-scanned foods are invisible to search (inactive version) → needed for re-use.
3. `simple_sugars` unenforceable on the bulk catalog → needed for the Avoids switches.
4. AI-capture 0.95 auto-resolve threshold unreachable → needed for the plate photo.

## Decisions that are Devin's (block the start)

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Gemini paid tier.** The free key is 20 calls/day. Nothing in T2–T6 can be proven snappy or evaluated (F-070) on it. | Enable billing on the Gemini project (Devin does this; `GEMINI_BILLING_ATTESTED=1` already exists as the guard). |
| D2 | **Keep the plate photo.** Reverses the 2026-09-10 "media deleted ≤ 24 h" ruling for one case. | Keep a 512 px thumbnail, linked to the entry, in the private bucket under her uid, deletable with the entry and by export-delete. Full-size stays 24 h. |
| D3 | **Water on Today.** The FAB logs it; nothing shows it. | Show cups as one small line in the progress card footer ("Still to eat … · 3 cups water"); apply the water-corrections migration. Alternative: drop the FAB row. |
| D4 | **Order.** See below. | T0 → T1 → T3 → T2 → T5 → T6 → T7, with T8/T9 folded in early because they are small and unblock the coach. |

**Decided by Devin, 2026-09-17:** D1 yes — billing on the Gemini project (Devin enables it;
`GEMINI_BILLING_ATTESTED=1` is set only after he confirms). D2 keep a 512 px thumbnail linked to
the meal. D3 one small water line in the progress card footer, and the pending migrations go to
production. D4 the order above. T1 does not need Gemini and starts first while billing is enabled.

Taken by me unless Devin objects: coach stays on Gemini Flash with a fallback model (speed over
depth); voice input uses the on-device Web Speech API first (free, instant, iOS Safari 14.5+),
server transcription as the fallback; every spec keeps "LLM proposes → database grounds → user
confirms" for capture, and "her instruction is the confirmation, the card with Undo is the safety
net" for the coach (ruling 2026-09-15).

## The tasks

Size: S (< 1 day), M (1–2 days), L (3–5 days). Each lands as one PR and one proof folder.

### T0 — Foundations for "snappy" and for proof (M)
- Paid Gemini key in place (D1). Latency instrumentation: `performance.now()` marks on every
  capture and coach path, reported to `ai_calls.latency_ms` (exists) and a new
  `client_timings` row per step (sign, upload, propose, ground, commit; coach: first token,
  action applied). A `pnpm timings` script that prints p50/p95 per path from the last N runs.
- Client-side `AbortController` timeouts on every capture and coach fetch; a visible "still
  working" state after 2 s; optimistic local write for log commits (the outbox already exists as
  the failure path — use it as the fast path).
- Parallelise grounding (`Promise.all` per item, per alternative); barcode matches in parallel.
- Warm routes: route-segment config so `/api/log/propose`, `/api/foods/barcode`, `/api/coach`
  are not cold on every call (Vercel fluid compute / min instances if the plan allows).
- Acceptance: p95 budgets, measured on the phone over Wi-Fi, 10 runs each — barcode warm ≤ 1.5 s,
  label ≤ 5 s, photo ≤ 6 s, coach first visible reply ≤ 3 s, coach action card ≤ 5 s.

### T1 — Sync mapping and the policy honours her list (M)  *(the F-057 follow-up)*
- `setFoodStatus` / `upsertFood` emit a `user_food_prefs` op (adopt-client pattern: `user_foods`
  upsert → `get_or_create_food_ref` → pref op). One-shot backfill for foods already on her phone.
- `evaluatePolicy` gains `onAvoidList → blocked, reason "avoid_list"`; every caller passes
  `prefStatus === "avoid"`. `policyCopy` already prints "On your avoid list".
- Categories: author the USDA-category → `banned_categories` mapping for the five keys (ruling 3);
  migration sets all five on her profile and the table default; the Avoids switches then mean
  what they say. Barcode-scanned versions become searchable (ruling 2).
- Acceptance: mark a food Avoid on the phone → within one sync the coach refuses to suggest it,
  search badges it "On your avoid list", the scanner flags it; a raw-onion USDA row is blocked
  when the switch is on and allowed when it is off.

### T2 — Photograph the plate, end to end (L)
- Grounding that resolves: the model is given the top-K catalog candidates per item in the same
  call (or one small second call) and picks; auto-resolve threshold becomes a measured precision
  gate per method (F-070), not 0.95 (ruling 4). Household portions from `catalog_portions` are
  passed to the model for unit → grams.
- Confirm sheet: editable meal name and per-item description; a time control defaulting to the
  photo's `DateTimeOriginal` (read client-side before the resize strips it), else the shot time
  captured when the camera input fires, else now; "Save as recipe" toggle; "Also save to my
  foods" per item stays.
- Image: thumbnail kept and shown on the Today card and in the entry sheet (D2).
- Today: the card appears at the photo's time in the stack (already sorts by `at`), with the
  description, kcal and macros, and the thumbnail.
- Acceptance: a fixed set of 12 plate photos (Sasha's real meals) each logs in one Save with
  the correct time, the correct item count, kcal within 15 % of the panel's reference, a
  thumbnail on the card; p95 ≤ 6 s; 0 items block Save on a resolvable plate.

### T3 — Scan a label, end to end (M)
- Fix the commit wiring: the client sends `label_food` and the placeholder ref; the label
  product is saved as a `user_foods` row (`kind: label_scan`) with the extracted per-100 g and
  allergen tags, so it is searchable, favouritable and re-usable.
- Skip catalog grounding for a label item (the nutrients are on the label); the model call
  returns name, brand, serving, per-100 g, ingredients; name is editable.
- Barcode row back on the production FAB (flag), and the scanned food gets its star.
- Acceptance: 10 real labels each save in one tap with name/brand/serving/per-100 g correct
  against the panel's reference; the product then appears in search and in "Log a food"; p95
  ≤ 5 s; a second scan of the same product is served from cache in ≤ 1.5 s.

### T4 — Log a food / Log a meal: polish and re-use hooks (S)
- Meal name travels on the wire (today it is display-only). Meal entries carry `items` and a
  name so T5 can turn them into recipes. Portion step and search debounce measured.
- Acceptance: a logged meal round-trips its name through sync; search-to-save p95 ≤ 2 s warm.

### T5 — Save, re-use, swap (M)
- "Save as recipe" from any logged entry (photo, label, meal, coach action) and from the confirm
  sheets; recipe gets the items, grams, per-serving macros, thumbnail if any.
- "Log again" on any recipe and on any past entry (the duplicate-fingerprint groups become
  "You logged this before" suggestions).
- Swap candidates: the meal-slot sheet gains "Your recipes" and "Recent meals" rows; a new meal
  id kind (`recipe:<id>`, `logged:<entryId>`) the rotation resolves; favourites-strip recipe chip
  logs a serving in one tap (the ticket the code already names).
- Acceptance: photo → save as recipe → swipe a slot → the recipe is offered → chosen → the slot
  shows it with the right macros → "Log again" tomorrow in two taps.

### T6 — Coach v2: context, memory, actions, speed (L)
- Memory: last N turns (bounded by tokens) plus a rolling thread summary, sent every turn;
  threads resume with their summary.
- Context injected every turn: her local time and tz (from the device), today's plan slots with
  items, planned times, eaten state and every logged entry with its time and macros, her Eats
  and Avoid lists, her recipes, targets and what is still to eat. New tools `get_plan`,
  `get_entries` for other dates.
- Actions added: `log_meal` gains `at` (time) and a free "snack" that is an extra, not a slot;
  `delete_entry`, `move_entry` (retime), `swap_slot` (to a recipe or a composed meal),
  `save_recipe`. Every action still applies client-side through the existing write paths, still
  shows the card with Undo, still writes nothing on the server during the turn.
- Quantity: the catalog's household portions ride on `search_foods` results; the model must cite
  the portion it used; top-3 grounding with a one-question disambiguation when the top-1 margin
  is thin.
- Suggestions: a `compose_meal` tool builds a real card from her Eats foods and recipes, sized to
  the slot target and passed through the policy — "turkey lettuce wrap with avocado" comes back
  as items with grams and a one-tap "Log it" / "Put it in Meal 2".
- Speed: streamed reply text; fallback model on 503; first visible token ≤ 3 s.
- Acceptance (the panel's script, run against the live route with a real model and a seeded
  day): "I just ate eggs, bacon and avocado at 9 AM — 3 eggs, 4 slices, half an avocado" → one
  card at 09:00 in Today with the right macros; "delete the bacon one" → gone; "move my lunch to
  1:30" → moved; "what should I have for lunch" → a composed, policy-clean card; a follow-up
  "make it 2 eggs" edits the same entry; the whole exchange survives a reload; p95 per turn.

### T7 — Voice for the coach (M), then voice-to-voice (separate spec)
- Hold-to-talk on the composer: on-device Web Speech API, live transcript in the box, release
  to send; server transcription fallback when the API is absent. Same acceptance script as T6
  spoken instead of typed, on the phone.
- Voice-to-voice (TTS reply, barge-in, hands-free) is scoped after T7 ships, per Devin.

### T8 — Water and weight (S)
- Water per D3. Apply the two pending migrations to production.
- Morning weight: her typed value shows in the header pill when no ingest value exists for the
  day, and is written as a `health_samples` row so the estimator sees it.

### T9 — Housekeeping (S)
- `components/TabBar.tsx:49` hydration mismatch. `app/settings/page.tsx` split under 400 lines.
  `docs/features.md` dispositions (F-093 says planned; it runs in production).

### R — Research (runs in parallel with T0/T1)
- Speech-to-text AI nutritionist landscape: what the best apps do for voice logging, quantity
  clarification, meal memory, and photo estimation — via `/deep-dive`, cited, filed in the
  Second Brain. Informs the T6 and T7 specs; not a gate.

## Order and dependencies

```
T0 ──┬── T1 ──────────────┐
     ├── T3 ── T2 ── T5 ──┼── T6 ── T7 ── (voice-to-voice)
     └── T8, T9 (any time)┘
R runs alongside T0/T1.
```
T6 needs T1 (policy sees her list), T5 (recipes and swap ids) and T0 (timings). T7 needs T6.

## The process, per task

Three roles, three different contexts, one loop:

1. **Spec** — I write `docs/plans/2026-09-XX-<task>.md` with numbered acceptance criteria
   (AC1…ACn). Devin approves.
2. **Panel** — a separate agent (Claude, not the coder) writes the hidden acceptance suite from
   the spec: vitest files plus phone-browser scripts, stored **outside the repo** at
   `~/Desktop/proof/<task>/acceptance/`. Grok 4.6 reviews the suite adversarially for gaps
   before the coder starts. The coder is never given the path or the test text.
3. **Coder** — Opus 5, from the spec only. TDD on its own tests, targeted runs, no full suite.
4. **Loop** — the panel copies the suite into a temporary `.panel/` in the repo, runs it (and the
   phone scripts through EGO Lite), deletes the copy, and returns failures to the coder as
   behaviour ("AC4: the card shows 08:15, expected 09:00"), never as test code. Repeat until
   every AC is green, capped at five rounds; a sixth means the spec is wrong and comes back to
   Devin.
5. **Adversary** — Grok 4.6 reviews the final diff with the full sources inline. Findings are
   triaged against the live app (last round: 15 of 19 were real). Fixes go back through step 4.
6. **Gates and land** — `pnpm test` once, tsc, lint, design lint; `zs-land`; production check.
7. **Proof** — `~/Desktop/proof/<task>/`: `acceptance-criteria.md`, `AC1..n.txt` (each run's
   output), phone screenshots and recordings, `grok-review.md`, `timings.md` (p50/p95),
   `production-evidence.md` (URL, sha, live check). Same shape as `t12b/` and `coach-enable/`.

Sonnet is not used for coding or tests in this program (Devin, 2026-09-17).

## Wrap-up (2026-09-18)

### Landed

| Task | What shipped | PR |
| --- | --- | --- |
| T0 | Speed foundations: timings, deadlines, optimistic commit, parallel grounding, warm routes | #215 |
| T1 | Sync mapping, and the policy honours her Eats/Avoid list | #211 |
| T6 | Coach v2: memory, her day in context, actions for her sentences, compose | #217 |
| T8 | Water and weight | #214 |
| T9 | Housekeeping | #213 |

The baby-food pouches came out of the plan and were replaced with real-food
pre-training carbs (#216). T7 — voice for the coach — lands today.

### Deferred, on Devin's decision

Not cut and not forgotten; each one needs a call from Devin before it starts again.

- **T3 — label scan.** The whole task.
- **T2 — plate-photo grounding quality.** The path works end to end; how well the
  model names what is on the plate is the open question.
- **T5 — save, re-use, swap.**
- **Voice-to-voice.** The separate spec after T7.
- **Weight-trend smoothing (F-084).**
- **T0 AC7–AC10 proofs.** Run in the readiness pass rather than under T0.

## As built: W124 and W125 (2026-10-17)

- **T3, label scan (W124).** A repeat scan of a product the account already saved reuses that
  `user_foods` row and its ref: same brand and name after case and spacing, every core per-100 g
  code present on both or neither, and every shared code within half a unit or 2 %. A rescan that
  names an allergen the saved food lacks saves a new food (`sameLabelFood`,
  `lib/server/log-label-food.ts`). The barcode confirm sheet stars the scanned food in Favorites
  wherever it opens. Left for the Mac: the 10-label eval and the p95 targets need live keys.
- **T2, plate photo (W125).** The phone reads the original JPEG's `DateTimeOriginal` (and its
  offset) before the resize drops it (`lib/media/exif-time.ts`), else the time the file was
  picked; the meal takes that time only on the capture's own day and never ahead of now
  (`lib/capture/shot-time.ts`). The confirm sheet has an editable meal name (a label's food name,
  which renames the saved food), a time control, and "Save as recipe" (one serving, allowed foods
  only, R6; `lib/capture/save-as-recipe.ts`). D2: the plate photo's 512 px copy is uploaded while
  the photo is read and linked to the entry after an applied commit through the existing
  `media_objects.entry_id`, so no migration; the media sweep removes it a day after its entry is
  deleted. Showing the thumbnail on the Today card and in the entry sheet is still to do.
  The auto-resolve gate number stays the owner's ruling.
