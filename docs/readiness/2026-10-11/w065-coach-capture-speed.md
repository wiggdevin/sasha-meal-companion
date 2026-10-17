# W065 — Coach and capture speed, measured (2026-10-11)

Spec: `docs/plans/2026-10-10-priority-spec-list.md` W065 (backlog B025). Budgets:
`docs/plans/2026-09-17-t0-speed-foundations.md` §6 (coach first visible text ≤ 3 s p95, label ≤ 5 s,
plate ≤ 6 s) and `docs/specs/phase-13-model-lanes-food-safety.md` §7 (coach turn p95 target 15 s,
ceiling 30 s). Streaming rule: owner decision OD06 (build streaming only if first-text p95 stays
above 6 s after this measurement).

## How it was measured

- Read-only, production (`fivatgdpuenszxxnijpc`), service-role scripts, run 2026-10-11 18:40 UTC:
  `pnpm timings --days 7|30|90`, `pnpm timings:ai --days 7|30|90 [--by-model]`. The 90-day tables
  equal the 30-day ones (the first row is 2026-09-18). Raw output: `w065-raw/`.
- No model was called. No row was written. Cost: $0.
- Lane split and cold/warm split: a one-off read-only join, not committed. A `coach-turn` run is
  "OpenRouter" when the same account has an `ok` `coach-openrouter` row in `ai_calls` inside the
  run's window, "Gemini" when it has a `coach` row instead, and "no model" otherwise (the Jev fast
  path, `model` = 0). A run is "cold" when it is the account's first coach turn after 15 minutes or
  more without one, else "warm". This is a proxy for AC10; it is not the controlled 5× idle test.
- The coach lane moved from Gemini (`coach`) to OpenRouter (`coach-openrouter`) on 2026-10-02.
  Every coach model call since 2026-10-03 is on OpenRouter (`google/gemini-2.5-flash` pin).
- The data is thin: 4 accounts, 939 rows in 90 days, last coach turn 2026-10-08. Read p95 on
  small n as a signal.

## Coach

First visible text is the whole reply: `first-text` = `reply-done` on every run (no streaming).

| Lane (`coach-turn` runs) | n | first-text p50 | first-text p95 | vs 3 s | vs 15 s |
|---|---|---|---|---|---|
| OpenRouter, all (2026-10-02 → 10-08) | 62 | 10.4 s | 18.3 s | 6× over | over |
| OpenRouter, last 7 days | 30 | 9.4 s | 14.2 s | 4.7× over | just under |
| OpenRouter, cold | 23 | 10.7 s | 15.8 s | over | over |
| OpenRouter, warm | 39 | 9.1 s | 19.1 s | over | over |
| Gemini (before 10-02) | 36 | 15.6 s | 30.5 s | over | over |
| No model (Jev fast path), last 7 days | 45 | 3.4 s | 7.6 s | over | under |
| All coach turns, last 7 days (`pnpm timings`) | 75 | 5.2 s | 13.0 s | over | under |

Where an OpenRouter turn's time goes (57 runs with a matched OpenRouter call since 10-02):

| Part | p50 | p95 |
|---|---|---|
| One OpenRouter call (`ai_calls`, `ok`, 7 days, n 58) | 2.4 s | 3.4 s |
| OpenRouter calls per turn | 2 | 4 |
| Client `model` step (all model calls of the turn) | 4.8 s | 10.3 s |
| Jev intent + reply check per turn | 0.7 s | 1.6 s |
| first-text − model − ground (server work and network outside the model) | 3.9 s | 9.6 s |

Readings:

- Coach first-text p95 on the OpenRouter lane is 14–18 s. It is far above the 3 s budget (AC9)
  and at the 15 s Phase 13 target: under it for the last 7 days, over it for the lane's whole life.
  It is well under the 30 s ceiling. The OpenRouter switch cut p95 from 30.5 s (Gemini) to 18.3 s.
- One model call is fast (2.4 s p50). A turn is slow because it makes 2 model calls at p50
  (up to 4) and spends about 4 s outside the model.
- Cold and warm do not differ in a way that points at cold starts (OpenRouter cold p95 15.8 s,
  warm 19.1 s). The cost is model round trips and server work, not function start-up.

## Capture

| Path | Telemetry (90 days) | p50 / p95 | Budget | Verdict |
|---|---|---|---|---|
| Label (photo → confirm) | client: 0 runs. provider `labelToNutrients`: 1 ok (4.8 s), 2 timeouts (19.7 s), last 2026-09 | — | ≤ 5 s | Cannot judge. No phone runs. |
| Plate photo (photo → confirm) | client `photo`: 2 runs, `commit` + `card-visible` only (no propose hop); provider `photoToItems`: 2 ok (2.0 s, 2.8 s), 2 provider errors | — | ≤ 6 s | Cannot judge. The two client runs time the commit only. |
| Text (type → confirm) | client: 2 runs, `propose` 27.4 s / 39.3 s; server `model` 1.8–1.9 s, `ground` 0.6–0.8 s; provider `textToItems-openrouter` 6 ok, 1.6 s / 1.8 s | see defect | — | Server side fast. Client `propose` was wrong (below). |
| Commit → card visible | 8 runs over photo, text, search-log | 2–7 ms | ≤ 100 ms | Pass. |
| Search → log commit | 2 runs | 2.2 s / 2.6 s | ≤ 2 s | Slightly over, n = 2. |

### Defect found and fixed in this PR

The two `text` runs came from the Plan panel (`lib/plan/photo-log.ts` `proposeDescribed` /
`proposePlate`). Those calls hand the draft to PanelReview and keep the run open until the person
confirms, but they never marked `confirm-shown`. The `propose` row therefore ran until the commit
mark and included the person's review time: 27–39 s against a 2.3 s server answer. The capture
sheet already marks `confirm-shown` (`components/CaptureSheet.tsx`). The fix marks it in the Plan
panel when the draft is ready to show. Test: `tests/plan/photo-log-timing.test.ts` (it reproduced
the 27 s figure before the fix).

## Streaming decision

**Build streaming (W091).** By OD06, first-text p95 is above 6 s on every lane (OpenRouter 14.2 s
for the last 7 days, 18.3 s overall; all turns 13.0 s). Streaming alone will not reach 3 s, because
about 4 s passes before the last model call starts and most turns make two model calls. W091 should
stream the final call's text and also attack the time before it:

1. Stream the final model call's text, held as draft until `coach-verify` passes (W091 guard).
2. Cut the second model call where the first already has the answer (2 calls at p50).
3. Trace the ~4 s of server work outside the model (Jev is 0.7 s of it) with `Server-Timing` on
   `POST /api/coach`.

## Gaps this report cannot close

- AC7 / AC8 (label and plate, 10 phone runs each) and AC9 (10 coach turns at ≤ 3 s) need phone
  runs. They bill the capture and coach lanes, so they were not run here (no metered calls). They
  are owner-run or a later item with a spend allowance.
- AC10 (controlled cold vs warm, 5× per route) was not run; the proxy above is all the data offers.
- Plate photo through the capture sheet records no `photo` propose rows in 90 days; re-check after
  real use.

## Billed phone-path run (2026-10-11, coach-eval branch)

The owner approved one billed run of the spec's smallest set: 10 label photos, 10 plate photos,
10 coach turns and a controlled cold-vs-warm test. Production was not touched.

### Setup

- Branch: the persistent `coach-eval` branch. Its data was saved first to
  `~/Backups/supabase/meal-companion-coach-eval/20261011T191338Z{,-full}.sql` (mode 600, off the
  repo). Then `scripts/db-branch.sh reset coach-eval` ran. Afterwards the branch's migration ledger
  matched the repo exactly (161 of 161 versions).
- Server: this branch built with `next build` and served by `next start` on :3535 on the
  developer's Mac, with the app's own lane pins and keys and every Supabase variable pointed at the
  branch. The test user is the coach-streak user, seeded by `scripts/eval/coach-streak-harness.ts`
  (profile, target revision, 18 catalog foods, Eats, three days of logs).
- Driver: a one-off script that signs in with cookie auth and calls the same routes in the same
  order as the phone, timing the same hops the phone marks. For capture that is `POST /api/media/sign`
  (sign), PUT to the signed URL (upload) and `POST /api/log/propose` (propose). For the coach it is
  `POST /api/coach`, sent until the reply arrives (first-text, which is also the full reply, since
  there is no streaming). It also records the server's own `model` and `ground` ms. No commit was
  sent, so nothing was logged.
- Images: label photos are 20 synthetic Nutrition Facts panels drawn with PIL (1200×1600 JPEG,
  q 80, slight tilt and blur). Plate photos are the app's 20 meal-art pictures (`public/meal-art`),
  converted to 1600 px JPEG q 80, the size `lib/media/resize.ts` sends from the phone.
- Cold vs warm: 5 cycles, each started after ≥ 15 minutes with no request to the server. Each
  route got one "cold" call followed at once by one "warm" call. The route order rotated between
  cycles. One extra coach-only cycle replaced a warm turn the 8-chat limit refused (`409
  chat_limit`; the cycles open a new chat per turn). The test user's old chats were then closed on
  the branch.

### Results: 10 runs each (main set)

| Path | n | sign | upload | propose | Total p50 / p95 | Budget | Server `model` p50 / p95 |
|---|---|---|---|---|---|---|---|
| Label (photo → draft) | 10 | 0.23 / 0.35 s | 0.32 / 0.54 s | 4.1 / 4.7 s | **4.6 / 5.4 s** | ≤ 5 s | 3.0 / 3.6 s |
| Plate photo (photo → draft) | 10 | 0.20 / 0.25 s | 0.36 / 0.61 s | 4.0 / 4.6 s | **4.5 / 5.3 s** | ≤ 6 s | 2.8 / 3.1 s |

| Coach | n | first-text p50 / p95 | Budget | Server `model` p50 / p95 |
|---|---|---|---|---|
| All 10 turns | 10 | **6.4 / 13.7 s** | ≤ 3 s (AC9), 15 s target | 4.3 / 12.2 s |
| Model turns (OpenRouter, `google/gemini-2.5-flash`) | 9 | 5.8 / 13.9 s | | 4.6 / 12.3 s |
| Jev fast path | 1 | 6.9 s | | 0 |

Coach model turns made 2.4 OpenRouter calls each on average (45 calls for 19 model turns across
the whole run), which matches production (2 at p50).

### Results: cold vs warm (5 pairs per route)

| Route | Cold p50 / p95 | Warm p50 / p95 |
|---|---|---|
| Coach model turn, first-text | 9.6 / 14.0 s | 7.0 / 12.0 s |
| Label, total | 5.1 / 7.8 s | 4.6 / 12.2 s |
| Plate photo, total | 4.5 / 8.1 s | 4.9 / 8.4 s |

There is no consistent cold penalty. The p95s come from one cycle (20:09 UTC) where every route
was slow, cold and warm alike (label warm 14.1 s, coach warm 13.1 s; model time rose on every
call). That is provider latency at that moment, not a cold start. Without that cycle, label and plate
cold and warm medians are within about 0.5 s of each other. Coach turns vary with the number of
model calls the turn makes, not with idle time: the slowest cold turn (15.0 s, cycle 6) spent
13.2 s in the model.

### Verdicts

- **AC7, label ≤ 5 s p95: not met, near.** p95 is 5.4 s (p50 4.6 s). Model time is 3.0 s; propose
  adds about 1 s of server work around it.
- **AC8, plate ≤ 6 s p95: met.** 5.3 s.
- **AC9, coach first-text ≤ 3 s p95: not met.** 13.7 s, close to the production 14.2 s (7 days). The
  15 s Phase 13 target is met here. This confirms the streaming decision above (build W091) and
  its two companions: fewer model calls per turn and less server work before the first token.
- **AC10, warm ping halves the first-tap latency: not measurable here.** `next start` on one machine
  has no serverless cold start, so the ping has nothing to remove. The controlled test shows that
  upstream connections (database, OpenRouter, TypeSafe) left idle for 15 minutes add no
  measurable time.

### Gaps (need a real phone or a Vercel deployment)

- Function cold start and the warm ping (AC10) need the deployed `sfo1` functions. A local
  server cannot reproduce them.
- The phone's own upload over cellular or Wi-Fi, and `card-visible`, need a phone and the UI. The
  upload here went from the developer's Mac.
- The commit hop was not sent, to keep the branch's log empty. Production telemetry above has it at
  2–4 s.
- Grounding ran against the seeded 20-food catalog, not production's 13,694 foods. Production's
  text `ground` step (0.6–0.8 s) is the better guide.

### Spend

From the branch's `ai_calls` after the run: **$0.146 in 105 calls**. That is coach-openrouter $0.101
(45), labelToNutrients-openrouter $0.026 (20), photoToItems-openrouter $0.018 (20), and Jev $0.0006
(20). No Gemini fallback call was needed.
