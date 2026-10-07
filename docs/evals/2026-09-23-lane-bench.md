# Lane bench — 2026-09-23

Phase 13 §3.2. 2 run(s) per fixture. Synthetic D0/D1 fixtures only (scripts/eval/lane-bench/fixtures.json). Latency is the wall clock of one model call from this machine, under each lane's own deadline: it is not an end-to-end coach turn or capture, so it is not §7 gate evidence. Cost counts every completed provider attempt (including schema-rejected retries); calls with no known usage are counted apart.

| Lane | Model | n | p50 ms | p95 ms | Schema-valid | Accuracy | Cost | Cost/call | Usage unknown |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| converse | gemini-3.6-flash | 12 | 1021 | 1511 | 100 % | 100 % | $0.00115 | $0.00010 | 0 |
| converse | gemini-3.8-flash | 12 | 892 | 1783 | 100 % | 100 % | $0.00115 | $0.00010 | 0 |
| converse | deepseek-flash | 12 | 607 | 764 | 100 % | 100 % | $0.00047 | $0.00004 | 0 |
| ui_chart | deepseek-flash | 8 | 846 | 1187 | 100 % | 63 % | $0.00184 | $0.00023 | 0 |
| ui_chart | gemini-3.8-flash | 8 | 1155 | 1429 | 100 % | 75 % | $0.00661 | $0.00083 | 0 |
| ui_replies | deepseek-flash | 6 | 647 | 958 | 100 % | 100 % | $0.00025 | $0.00004 | 0 |
| ui_replies | gemini-3.8-flash | 6 | 737 | 920 | 100 % | 100 % | $0.00070 | $0.00012 | 0 |
| capture_text | gemini-3.8-flash | 12 | 1378 | 5015 | 83 % | 83 % | $0.00973 | $0.00081 | 0 |
| capture_text | gemini-3.7-flash | 12 | 2266 | 6797 | 83 % | 83 % | $0.00856 | $0.00071 | 0 |

**Rescored 2026-09-24 against the current `score.ts`.** This is not a new run: every row above keeps
the original 2026-09-23 run's latency, schema-valid rate and cost. Only `correct`, the accuracy
column and the verdicts below were recomputed offline (`pnpm exec tsx --conditions=react-server
scripts/eval/lane-bench.ts --rescore docs/evals/2026-09-23-lane-bench.json` — no model calls, no
network, no billing; the flag is required even for a rescore, because the module's imports are
evaluated eagerly regardless of which path runs) from
each attempt's saved answer, against the scorer as it stands after review round 2 of this slice
(a caption's claimed trend — "fell", "rose" — is checked against the actual points; a captured
item's `grams` is checked, not only its label and count). Still a single-model-call measurement,
not the §7 end-to-end coach-turn or capture p95 gate.

**This is the second rescore of this report, and the first one had already gone stale before this
round started (review round 2, spec finding, BLOCK).** The 2026-09-24 rescore committed alongside
this note previously reported ui_chart accuracy of 38 % (deepseek-flash) / 63 % (gemini-3.8-flash).
Those numbers were correct against `score.ts` as it stood at commit `14632dc`, but a later commit
in that same PR (`9fec0a1`, "check chart captions for contradiction, not only the series label")
changed the scorer again — fixing a real bug (a truthful trailing restatement of an already-correct
value was wrongly failing the caption) — without a fresh rescore following it. The numbers below
are that fresh rescore, against `score.ts` as it now stands (also including this round's own
caption-direction and capture-gram fixes, both below). `tests/eval/lane-bench-report-freshness.test.ts`
now closes this gap: it recomputes every committed attempt's `correct` against the live scorer and
fails if they ever diverge again, so a future scorer change without a matching rescore is caught
here, not by a reviewer's manual reproduction.

## Verdicts against the current pins

- converse: gemini-3.8-flash does not beat the pin gemini-3.6-flash on model-call p95 and accuracy under the §3.2 rule. End-to-end §7 timings are not measured here.
- converse: deepseek-flash is NOT ELIGIBLE: deepseek is not cleared for D2, which the converse lane carries in production.
- ui_chart: gemini-3.8-flash BEATS the pin deepseek-flash on model-call p95 and accuracy under the §3.2 rule. End-to-end §7 timings are not measured here.
- ui_replies: gemini-3.8-flash BEATS the pin deepseek-flash on model-call p95 and accuracy under the §3.2 rule. End-to-end §7 timings are not measured here.
- capture_text: gemini-3.7-flash does not beat the pin gemini-3.8-flash on model-call p95 and accuracy under the §3.2 rule (text capture only: not a capture-wide pin decision for photo, voice or label). End-to-end §7 timings are not measured here.

## Failed calls

- capture_text gemini-3.8-flash k3: schema_invalid
- capture_text gemini-3.7-flash k3: schema_invalid
- capture_text gemini-3.8-flash k3: schema_invalid
- capture_text gemini-3.7-flash k3: schema_invalid

## Interpretation (slice 1; no pin changes)

- **No pin changes in this PR.** Slice 1 is "no behaviour change" (spec §7) for the lane table and
  every production request path. This report is the evidence format a pin PR must attach (§3.2).
  Every figure is one model call on synthetic fixtures; none of it is §7 end-to-end evidence
  (coach turn or capture p95).
- **The §7 "coach turn / capture p95 must not rise" gate needs no before/after latency measurement
  here** (GPT-6 Sol review round 1, BLOCK #3), because nothing in this slice adds an await, I/O or
  retry to the coach-turn or capture request path: every ui/converse candidate above is rejected
  or not eligible, so `lib/ai/lanes.ts`'s pins are byte-for-byte what production already calls
  today, and this report's own harness never runs in the coach-turn or capture request path (it is
  a standalone script, never imported by `app/` or `lib/server/`).
- **One production-path change in this slice is NOT latency-neutral, and this report does not
  claim it is (review round 2, sol finding, BLOCK).** `geminiCall` now counts
  `usageMetadata.thoughtsTokenCount` into `outputTokens` (`lib/ai/adapter.ts`), which raises every
  Gemini call's recorded `ai_calls.cost_estimate` — and so what `assertUnderSpendCap` enforces, for
  every production Gemini caller (coach, capture, weeklyReview), not only this bench. That is a
  real, disclosed behaviour change: a caller whose cumulative spend previously stayed under the
  daily cap under the old, understated accounting can now be refused with `429 spend_cap` where it
  previously proceeded (`lib/ai/lanes.ts`'s disclosed exception,
  `lib/ai/adapter.gemini-usage.test.ts` covers it end to end, including the 429). It is genuinely
  irrelevant to the §7 *p95* gate specifically — a spend-cap refusal fails before any provider
  round trip, so it cannot raise a coach-turn or capture call's own latency, and the arithmetic
  addition itself adds no await — but it is not "no behaviour change" in the way this slice's
  request-shape and pin changes are, and a PR relying on that broader claim should point to this
  paragraph and the linked test rather than assume the p95 argument above covers it.
- **This is a rescoring, not a new run (2026-09-24, second rescore — see the note above the
  table).** The committed 2026-09-23 report had drifted out of sync with `score.ts` twice now:
  once across the rounds of chart-scoring fixes that preceded the first rescore (reproduced
  directly: replaying this run's own saved `gemini-3.8-flash`/u2 answer, series label
  "Macronutrients", through the scorer as committed at `14632dc` already returns `false`, not the
  `true` the original report recorded), and a second time when `9fec0a1` changed the scorer again
  right after the first rescore was committed, without a further rescore following it. The table
  above is the honest re-score of the same answers against the scorer as it stands now; nothing
  was re-run against a model.
- **converse:** all three models get every value right. gemini-3.8-flash does not beat the 3.6
  pin. The 3.6 coach pin exists for capacity (3.8/3.7 returned 503s in the 2026-09-13 canary),
  which this bench cannot measure. DeepSeek is fastest but NOT ELIGIBLE: the converse lane
  carries D2 and DeepSeek is cleared for D0/D1 only. The fixtures sent to DeepSeek for this lane
  are now checked, not only documented, as D1-only (`scripts/eval/lane-bench/d1-guard.ts`, review
  round 2, correct finding): every converse case is scanned for D2 marker words (allergy,
  condition, medication, clinician, …) before the call, and the bench refuses to run a case that
  fails that check.
- **ui — input for slice 5, not decided here:** chart blocks are scored on every point, the unit,
  the series label (whole word, bare plurals allowed, a contradicting qualifier like "kcal
  burned" rejected outright), every number in the caption attributed to the label it actually
  names, and — new this round — any "rose/fell from X to Y" trend the caption itself claims,
  checked against the real points (review round 2, sol finding: "Calories fell from Mon to Tue"
  for a Mon-to-Tue rise previously scored correct, because every existing check was about values,
  never the caption's own directional claim). On that rubric gemini-3.8-flash beat deepseek-flash
  in this rescoring (75 % vs 63 %): a `weight_trend` caption that names only the first and last
  week by label, then repeats every week's number again in a trailing, unlabelled list (e.g. "with
  values 82.1, 81.6, 81.4, 80.9, and 80.7"), is a truthful restatement under the current scorer
  (fixed in `9fec0a1`: it is not a false claim about a third, unnamed point, so it no longer fails
  on attribution grounds); "Macronutrients" is a compound word, not a plural of the expected
  "macro", so it still does not match on a substring coincidence. DeepSeek also still computed a
  weekly total the values did not state ("totaling 14000 kcal") and once labelled the macros
  series "grams", both real misses under any version of this scorer. Reply buttons: both 100 %;
  Gemini's p95 was lower in this run, DeepSeek's in earlier runs, at about a third of Gemini's cost
  per call. Latency on both varies run to run by more than the gaps measured. Slice 5 should re-run
  this with more fixtures per block type before pinning the ui lane, and must keep the 4 s budget
  and the deterministic fallback either way.
- **capture (text only — not a capture-wide decision for photo, voice or label; review round 1
  finding 6, closed at round 2 by scoping and labelling exactly this way).** 3.7 is slower than the
  3.8 pin at equal accuracy. 3.7 rejects `thinkingLevel: MINIMAL` (recorded in `lib/ai/lanes.ts`).
  Both fail k3 ("150 g grilled chicken breast and a cup of rice") every time: the production
  capture schema caps `qty` at 100 servings (`lib/ai/schemas.ts`) — it is a count, never a gram
  weight — so a model that reads "150 g" onto the wrong field cannot pass validation for this
  input, and fails with 422 in production today (flagged separately; not a lane-bench bug). The
  fixture itself no longer asks the impossible: it previously checked `qty: 150` against that same
  capped field (review round 2, sol finding — a schema-invalid expectation baked into the fixture,
  scoring the bench's own mistake rather than the model), which is now checked as `grams: 150`
  instead, the field a correct extraction (`qty: 1, unit: "g", grams: 150`) can actually satisfy.
  k3 still fails every recorded attempt here because these are the ORIGINAL run's saved answers
  (schema-rejected, value `null`) — this rescore recomputes `correct` from what is already on
  disk, and cannot retroactively know what a model would have returned against the corrected
  fixture without a new, billed run. Every other capture fixture's amount claim is now checked
  against the model's stated `grams`, not only its food label and count (review round 2, sol
  finding, reproduced: "two eggs and a slice of toast" extracted as two *kilograms* of eggs and one
  kilogram of toast previously scored correct); this did not change either model's reported
  accuracy here, since both models' real recorded k1 answers already stated reasonable weights
  (100 g / 30 g).
- Cost counts every completed provider attempt, including schema-rejected retries; an attempt
  whose provider sent no usage counts is unknown, never zero. DeepSeek costs use peak rates.
