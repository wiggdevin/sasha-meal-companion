# Owner decisions, 2026-10-12

Devin's answers to the owner decisions in `docs/plans/2026-10-10-priority-spec-list.md` ("Owner
decisions") and to the open questions from wave-2 PRs. Claude (Opus 5.5) and GPT-6.1 Sol each
reviewed every item independently against the repo; where they disagreed, the verified point was
adopted before the owner chose. Brief and Sol's table: session scratch, summarised here.

| ID | Decision |
|---|---|
| OD01 | Keep the $50 global daily AI cap. Background jobs get at most $10/day, and part of each account's $2 cap is reserved for its own interactive turns, so background work can never use it up. Both splits count open reservations. Raise only when spend alerts show pressure. |
| OD02 | No new vendor. W053's crash reports and Vercel runtime logs, plus a scheduled GitHub Actions check of `/api/health` that opens one deduplicated issue per outage (no personal data in the body), and alerts for a stale backup or a job pass that did not finish. |
| OD03 | A scheduled job encrypts a `pg_dump` and stores it in a private bucket at a provider already in use; the local `scripts/backup.sh` copy continues. Nothing is published as a GitHub Actions artifact (the repo is public). Restore drills cover SQL and Storage. PITR waits for the next plan upgrade. |
| OD04 | Restart Undo receipts PR B for the three single-write v1 kinds (`log_meal` create, `save_recipe` create, single-date `set_slot_meal`), with a server-issued identity bound to the applied write. Coach target writes stay, through the checked writer. |
| OD05 | Retire the Phase 14 voice-to-voice spec; keep tap dictation; revisit spoken replies only with a native app. |
| OD06 | Build streaming (W091) now: the W065 measurement put first-text p95 at 13.7 s. Stream the final call's text as a draft until verification passes, release cards once validated, and cut serial model round trips (2.4 calls per turn); streaming alone does not reach 3 s. |
| OD08 | Dish-marker penalty for short ingredient queries and a 0.6 typo fold, behind the R1 relevance gate, with regression cases so explicit dish names and exact matches still win. |
| OD09 | Seven-day negative cache for genuine misses only (upstream failures are not misses); defer cooked-weight capture; document the real vault item behind `FDC_API_KEY`. |
| OD10 | Honest recipe "no match" (alternatives clearly labelled), a neutral over-target day flag, snap the water dial; grow toward 48 recipes where wider-pilot searches show gaps. |
| OD11 | One review session with a qualified clinician Devin chooses, covering condition-pack wording and the rebalance panel (copy and highlighting). `CONDITION_PACKS_ENABLED` and `REBALANCE_PANEL_USER_IDS` stay off until approval; signed originals stay private and a sanitised approval receipt is committed. |
| OD12 | Build the missing fail-closed gate for health-bearing Jev payloads (`JEV_HEALTH_ATTESTED` has no runtime check today, and reply verification sends whole replies); ask TypeSafe for health-data and retention terms (Devin sends the email); add a privacy notice naming third-party processors. |
| OD13 | No like term, no cross-user taste learning (T3); shopping focus and pantry photo stay pilot-only; W15 starts with stable randomized assignment before exposure once onb3 is ready. |
| OD14 | Keep the twelve tracked codes; drop the unowned exercise-export promise; keep the current coverage metrics. Stop calling the fixed fibre band or the female 19–30 DRIs "your" values (`components/DayNutrients.tsx`) until each account has its own references. |
| OD15 | Already done: `20261026090200_retire_legacy_store` dropped `foods`, `days` and `settings`; production has none of them (checked 2026-10-12). |
| OD16 | Finish the duplicate-meal card (`wip/2026-10-08-duplicate-card`), including cross-device group sync, Keep both, Merge and exact Undo; the migration gets a fresh review. |
| OD17 | Paging moves into the full tip view; the ring track uses the hairline token; checked on rendered phone views. |
| OD18 | Defer the supplement tick until another account asks. |
| OD19 | Sprout reacts negatively only when poked, never to a food or water shortfall (remove the shortfall-driven `droopy`). Edit becomes a visible menu item; long-press stays as a shortcut. |
| OD20 | Sleep totals only; weight unit from `user_settings`. |
| OD21 | Close Phase 6 OQ4 (pace is self-service through the checked onboarding presets). Review R3 when enough day-mark evidence exists and R9 against the cycle-method evidence, separately. |
| OD22 | The Oct 4 meal changes in Devin's data were his own. Leave the starter foods as they are. |
| OD23 | Defer a native iOS wrapper and direct HealthKit. |
| OD24 | Hold fast-path thresholds until 100 eligible production turns, then review outcomes by intent and mutation type. |
| OD25 | Phase 10 stays superseded (already marked). Phase 11 stays: it still describes shipped chat behaviour. Delete the `wip/2026-10-08-onb2-*` branches after a diff shows main or an archive holds what matters. |
| OD26 | Keep the four-food cap and defer regional priors; tell the user when foods were left out (W156). |
| X1 (W006, P20) | No backfill of `day_marks_started_on` (the true start cannot be rebuilt). Measure the affected accounts first; an earlier cutoff can exclude unmarked coverage-complete days. |
| X2 (W025) | Add a server-owned reconnect status on health sources, set only on terminal OAuth failures and cleared on reconnect, before Oura is enabled for any account. Do not store `returnTo` on the state row. |
| X3 (W052) | Done: production `password_min_length` raised from 6 to 8 on 2026-10-12 (Management API; CAPTCHA and forwarding unchanged). Next: a server-only Auth client with a secret key and `Sb-Forwarded-For`, then turn forwarding on. CAPTCHA (Turnstile) only if abuse appears, with owner approval. |

OD07 was decided on 2026-10-11: keep the 0.95/0.30 auto-resolve gate for now.
