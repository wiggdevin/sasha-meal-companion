# Jev everywhere — Sol adversarial rulings (2026-09-20)

Devin (2026-09-19): "use GPT-5.6 Sol as an adversarial or to double-check your work" on the Jev integration.
Reviewer: Codex GPT-5.6 Sol, effort xhigh, read-only sandbox, packet `~/.claude/goal-state/sasha-chat-first/lanes/sol-jev/`.
Verdict: **ADOPT WITH CHANGES** (5 BLOCK, 5 FIX). Driver disposition: all ten adopted; PRD §5 rewritten. Devin can reverse any row.

| Q | Sol's finding | Sev | Disposition | Applied where |
|---|---|---|---|---|
| 1 | Stored `diet_prefs.text` and flags as Jev state contradict the disclosure; verification prose can echo weight/gut/notes | BLOCK | Adopted: only the current utterance + minimal food fields reach Jev; stored data never; verification skipped on context-reading turns | PRD 5.1 F10, 5.2 Suggestions |
| 2 | IBD/UC/Crohn → high_fodmap is not clinically sound (AGA, ECCO) | BLOCK | Adopted: `condition-rules.ts` EMPTY in v1; additions are a nutritionist owner step; `low_fodmap` only as a user-confirmed preference | 5.2 Conditions, 5.6 |
| 3 | Unknown facet becomes "allowed" under today's policy | BLOCK | Adopted: `unverified` outcome; logs mark, automatic suggestions/recipes/plans exclude | 5.2 Verdicts |
| 4 | Facet misses and sanity on the hot path break "barcode: no Jev", "capture: capture model only"; no real 3-call bound | BLOCK | Adopted: `readFacets` cache-only interactive; warming off-path; sanity async after render; request-scoped budget of 3 logical calls | 5.1, 5.2 Service/Sanity, C6a |
| 5 | Name-keyed cache merges "Chicken, nuggets" with "Chicken", brands, user foods | BLOCK | Adopted: keys by catalog revision / user food + rev, input hash, rubric version; service-role-only RLS | 5.2 Storage |
| 6 | Fixed 0.70/0.60/0.30 thresholds conflate stakes; Score confidence ≠ Noul probability | FIX | Adopted: per-question, per-action thresholds frozen from a dev split, holdout reported, level probabilities gate | 5.1, C6b, C17 |
| 7 | Jev must not clear deterministic evidence; halal/kosher cannot be established by absence | BLOCK | Adopted: precedence floor/avoid → ingredient → category → Jev; halal/kosher unverified without certification evidence; stored role wins | 5.1, 5.2 Facet rules |
| 8 | "Choosing meals" under-served: no role advice for role-less foods | FIX | Adopted: advisory `meal_component_role` Choice, user confirms | 5.2 Suggestions, C4a |
| 9 | Task collisions with Phase B; 400-line guard; C3/C4/C6 are each two tasks | FIX | Adopted: C1a/C1b, C6a/C6b, C3a/C3b, C4a/C4b; integration after landing 2; split `suggest.ts`/`onboarding-state.ts` first | 5.3 |
| 10 | Serving identity is what experienced trackers notice first | FIX | Adopted (cheap part): pre-parsed serving-identity Choice among code-found candidates + `none`; yield math and serving history recorded as follow-ups (**deferred 2026-10-17**: not on a core flow of the in-house prototype) | 5.2 Sanity, 5.7 |

Residual risks (Sol): model-alias drift invalidating thresholds (rubric versioning + scheduled re-evaluation); utterances may still disclose sensitive facts under the existing disclosure; ingredient data stays incomplete so "Not verified" cannot be eliminated; any condition rule is clinical content.
