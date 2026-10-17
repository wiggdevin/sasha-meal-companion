# Ruling 2026-10-04 — static → adaptive TDEE handoff (step E)

Owner: Devin (autonomous session; every call here is reversible and recorded). Spec:
`docs/specs/phase-16-adaptive-handoff.md`. Review: GPT-6 Sol (`gpt-6-sol`, xhigh), full text
`~/Inbox/notes/sasha-tdee-e-spec-gpt6.md`. Every finding was checked against the code and the
fixtures; all four BLOCKs and four WARNs are adopted, with the exceptions named below.

## Rulings

- **R1. Two windows, used in order.** `provisional` uses the 14-day observation once it is valid
  (≥ 10 qualified days in 14; ≥ 6 weigh-in days spanning ≥ 11 days). The 28-day observation replaces
  it once valid (≥ 14 qualified days in 28; ≥ 12 weigh-in days spanning ≥ 24 days, ≥ 2 readings in
  each 7-day block). Either window also needs a reading within 2 days of `asOf`. One reading per day:
  the day's median. *(Review 1, 7.)*
- **R2. Fade by schedule, gate by quality.** `dataWeight = clamp((lifetimeQualified − 14) / 28, 0, 1)`
  applied only to a valid observation. Quality is a gate, not a multiplier. *(Review rulings.)*
- **R3. "Day fully logged" is required for proposals once marking starts.** The first-ever mark date
  is stored on `user_settings.day_marks_started_on` by a trigger and never moves later, so clearing a
  mark cannot restore the old rule. Before that date, coverage-qualified days count; on and after it,
  only marked days count. An account that has never marked keeps today's behaviour (coverage days,
  proposals allowed) — otherwise every current account loses proposals until the UI ships. The
  engine states that consistent under-logging is not identifiable. *(Review 3; the "never marked"
  carve-out is ours.)*
- **R4. Measurement and proposal eligibility are separate.** `status` describes the measurement;
  `proposalEligible` is its own boolean. Eligible needs: the 28-day observation valid; ≥ 21 qualified
  days in 28; ≥ 28 calendar days since the first qualified day; 14/28 agreement within
  `max(150, 8 % × observed28)`; no data-quality hold on any of the 7 preceding calendar days
  (recomputed from the inputs, not read from stored rows, so a deferral cannot sustain itself);
  half-width ≤ `max(200, 10 % × tdee)`; no review flag (R5). `buildProposal` also requires a move of
  ≥ 75 kcal/day on the weekly average. *(Review 4.)*
- **R5. Far from the seed is a review flag, not a veto.** `|observed28 − seed| > 35 % × seed` sets
  `reviewFlag` and pauses proposals; the estimate still fades. The flag releases after 14
  consecutive days of valid, agreeing observations. Outside 0.9–2.2 × BMR is the same kind of flag;
  the value shown is clamped and the reason says so. *(Review 5, bounds.)*
- **R6. Range is an empirical variation band, not a confidence interval.**
  `halfWidth = max(150, (1 − w) × 0.15 × seed, |obs14 − obs28|, max over the valid prior 14 days of
  |obs28(today) − obs28(day)|)`, terms omitted when their observation does not exist, rounded to
  10 kcal. Day 0 of the persona: 1,873 ± 281 → 1,590–2,150. *(Review 6.)*
- **R7. Steps never move the point estimate.** `activityContext` is passed through for context and
  copy; the step-informed selection of the 14-day observation (`STEP_INFORMED_ESTIMATOR_ENABLED`) is
  retired in `exp-3.0.0`. *(Review rulings.)*
- **R8. A held day shows the most recent valid estimate from the last 28 days**, else the seed. It is
  recomputed from the inputs, so the engine stays stateless and a gap never lowers the number.
- **R9. Acceptance restated.** Cycle (old acceptance 6): no proposal and the range contains the
  truth at day 42; a point-error bound waits for a validated cycle-aware method. Known loss
  (acceptance 4): 1,800 + 0.5 × 7,700 / 7 = 2,350 ± 60. Ramp (12): no opposite-sign proposal within
  28 days. Dates (13): days are the logged ISO local dates; nothing re-derives them from a zone.

- **R10. Fluid cycles are fitted out (exp-3.1.0, added the same day at Devin's request).** Over the
  last 56 days (≥ 16 weigh-in days spanning ≥ 38), after dropping readings beyond
  max(0.5 kg, 3 × scaled MAD) from a Theil–Sen line, the engine fits a line, a line plus one
  sinusoid (period searched over 24–35 days), and two one-time alternatives: a level step and a
  slope bend at the best breakpoint ≥ 7 days from either end. The sinusoid is kept only when its
  amplitude is ≥ 0.3 kg and its BIC beats the line AND the better one-time model by ≥ 10. It
  only refines a valid recent 28-day window; it never revives stale intake. In cycle mode the
  14-day and 28-day windows are de-cycled with the fitted swing and must still agree with the
  56-day observation before a proposal. Until the account has 38 days of weigh-in history the data
  weight is capped at 0.5 and no proposal is made; a later missed reading does not re-cap.
  Measured: ±0.8–1.2 kg cycles of 24–35 days at every phase stay within 50 kcal of truth from
  day 42 (exp-3.0.0: up to 908). No wrong proposal for stale intake, a one-time 1.5 kg drop, a
  1.5 kg scale shift, a 750 kcal diet change, or sparse (3/week) weigh-ins; a real change for a
  cycling account is never overshot. The first proposal moves from about day 28 to about day 39.
  Round 2 added: a joint cycle + level-step fit (a step found with a cycle is removed from the
  slope and pauses proposals for 28 days); the six-week gate counts from the current run of
  weigh-ins (a gap over 14 days restarts it); the band uses the de-cycled 14-day window. A real
  change for a cycling account lags like a non-cycling one (zero overshoot, same lag). A cycle must
  also repeat (similar size and phase in both halves of the window) and persist (the same period
  ± 3 days found 14 and 28 nights earlier) before it can carry a proposal; a step counts only at
  ≥ 0.7 kg.
  Reviews: GPT-6 Sol round 1 (`~/Inbox/notes/sasha-tdee-e-cycle-review-gpt6.md`, two BLOCKs and
  two WARNs, all fixed) and round 2 (`~/Inbox/notes/sasha-tdee-e-cycle-review2-gpt6.md`).

## Not adopted

- Review 3 asked for 21 *marked* days for every proposal. Accounts that have never marked keep
  coverage days (R3) until the UI ships the control; revisit when it has been live for 30 days.

## Revisits (OD21, 2026-10-12)

R3 and R9 are reviewed separately, each on its own evidence, never together:
- **R3** is reviewed once enough day-mark evidence exists (the day-complete control live for 30
  days, and enough marked days across accounts to compare against coverage days).
- **R9**'s point-error bound for the cycle acceptance is reviewed against the cycle-method
  evidence, once a validated cycle-aware method exists.
Until then both rulings stand as written.
