# Meal Companion audit 2026-10-10

Read-only audit of the `meal-companion` repo at `main` (commit 7405f41f). No code changed.

## Scope

The whole product: nutrition maths and food data, coach and AI calls, meal planning and shopping, sync, targets and onboarding, health ingest, exports and jobs, Supabase migrations and RLS, the Today UI, and the MCP route.

## Method

1. 26 Sonnet finders, one per area, each read code and wrote findings.
2. 2 gap rounds looked at what the first round missed.
3. 6 Opus finders took the hardest areas. Their findings carry round tag `opus-gap` (20 confirmed).
4. Leads from the architecture docs were checked by hand.
5. Each finding went to two agents. A refute agent tried to disprove it. A reproduce agent tried to show it from the code or a test.
6. Confirmed means both agreed. Plausible means one agreed.
7. GPT-6.1 Sol re-checked the 10 high findings from round 1. It confirmed 9 and refuted 1. It re-rated 8 of the 9 from high to medium.

The verdict text of each check is kept in the raw audit data. No finding was run against production.

## Result

Confirmed: 167. Plausible: 20. Dropped after the Sol check: 1 (A129).

### Confirmed, by area and severity

| Area | High | Medium | Low | Total |
|---|---|---|---|---|
| nutrition accuracy | 2 | 15 | 10 | 27 |
| feature accuracy | 0 | 8 | 17 | 25 |
| AI/tool calling | 0 | 13 | 14 | 27 |
| determinism | 0 | 4 | 10 | 14 |
| architecture | 0 | 0 | 4 | 4 |
| sync | 0 | 7 | 9 | 16 |
| security | 0 | 4 | 14 | 18 |
| DB | 0 | 2 | 9 | 11 |
| UI | 0 | 2 | 2 | 4 |
| ops | 1 | 12 | 8 | 21 |
| **Total** | 3 | 67 | 97 | 167 |

### Plausible, by area

| Area | Plausible |
|---|---|
| nutrition accuracy | 1 |
| feature accuracy | 3 |
| AI/tool calling | 3 |
| determinism | 1 |
| architecture | 0 |
| sync | 2 |
| security | 5 |
| DB | 2 |
| UI | 1 |
| ops | 2 |
| **Total** | 20 |

Area is one label I assigned from the file and category. Some findings touch two areas. Counts use the main one.

### Sol cross-check

- Refuted: A129 (approving a pending proposal built before a pace hold). The approval is dated to `week_start`, the hold revision is dated today, and `activeProfile` ranks `effective_from` before `rev`. The hold stays in force. A129 is removed from the confirmed list and the counts.
- Kept high: A009 (failed health apply is swallowed).
- Re-rated high to medium: A010, A030, A046, A048, A078, A085, A093, A112.
- A112 and the meals part of A085 are one defect. Fix them together.
- Two high findings came from the Opus gap round and Sol did not check them: A154 and A157.

## The 15 most important findings

Ranked by data harm and by safety rules first, then by how often a user hits it. Sol's re-ratings are applied.

| # | Id | Sev | Area | Finding | File |
|---|---|---|---|---|---|
| 1 | A009 | high | ops | Failed apply permanently swallows the payload: a retry is answered 'duplicate' | `lib/server/health-ingest.ts:95` |
| 2 | A154 | high | nutrition accuracy | Adding a catalog food to Eats/Favored stores unmeasured nutrients, including calc-only energy, as measured 0 | `components/add-food/catalog-food.ts:17` |
| 3 | A157 | high | nutrition accuracy | Weekly proposal can never lower the training day, so downward TDEE corrections are suppressed for accounts with 3 or more training days | `lib/proposal.ts:137` |
| 4 | A068 | medium | security | Authenticated users can write target_profiles directly, bypassing every server-side safety floor and pace hold | `supabase/migrations/20260911000500_rls.sql:11` |
| 5 | A097 | medium | security | Direct PostgREST writes to target_profiles (and user_settings) still bypass every server target safety rule | `supabase/migrations/20261228090000_target_writes_service_role_only.sql:28` |
| 6 | A115 | low | security | Path traversal in fetchOwnedObject lets pantry/photo and coach/transcribe read another user's media with the service role | `lib/server/media.ts:70` |
| 7 | A099 | low | security | pantry/photo accepts an unvalidated mediaPath, so the owner check passes a path-traversal key | `app/api/pantry/photo/route.ts:24` |
| 8 | A023 | medium | AI/tool calling | Plan writes (set_slot_meal, add_slot_item, set_slot_item) never check diet-flag or profile hard rules | `lib/coach/policy.ts:94` |
| 9 | A128 | medium | AI/tool calling | Coach plan writes (set_slot_meal / add_slot_item / set_slot_item) skip diet flags, profile hard rules and the human-food check; unverified foods pass | `lib/coach/actions/ground-kit.ts:33` |
| 10 | A130 | medium | AI/tool calling | Menu photo and uploaded-menu screening ignore the account's diet flags, so a vegetarian/halal/kosher menu pick can carry no warning | `lib/server/plan-menu.ts:28` |
| 11 | A087 | medium | UI | Legacy onboarding form never runs the safety round, so pace holds are never stored | `components/Onboarding/OnboardingFlow.tsx:281` |
| 12 | A094 | low | feature accuracy | A new under-18 signal leaves the account's existing paced revision in force | `lib/server/target-recompute.ts:260` |
| 13 | A085 | medium | ops | Meal, recipe and water exports silently truncate at PostgREST max_rows (1000) while the default limit is 5000, and no next cursor or truncation notice is emitted | `lib/server/export.ts:198` |
| 14 | A030 | medium | nutrition accuracy | Label capture with 'Save as my food' (on by default) is always refused with 422 | `lib/capture-client.ts:386` |
| 15 | A048 | medium | feature accuracy | Photo-confirmed pantry items (null food ref and null FoodDB id) crash every shopping preview | `lib/shopping/planner.ts:170` |

## What was not covered

- No live production data, no production RLS dump, no load test. All results come from code, migrations and local tests.
- The audit did not run the full test suite or CI.
- Visual design, copy and accessibility were not graded, except where a defect changes behavior.
- Third-party services (Supabase, Vercel, Gemini, OpenRouter, TypeSafe Jev, Oura) were not tested. Only our calls to them.
- Catalog and NHANES data content was not checked row by row. Only the import and mapping code.
- The plausible findings are unproven. The two verifiers split on each.
- Findings the finders did not raise are unknown. A clean area is not a proven clean area.

## How to read ids

- `A###` is a confirmed finding. `P##` is a plausible one. The number is a serial, not a rank.
- Severity: high means data loss, a bypassed safety rule or a wrong health number for many users. Medium means a wrong result a user can hit in normal use. Low means an edge case, a hardening gap or a small cost.
- `file:line` is where the defect starts, at the audited commit. Lines drift.
- The verification line says how many checks agreed and what the Sol cross-check said.
- `findings.md` groups by severity, then area. Search for an id to jump to it.
