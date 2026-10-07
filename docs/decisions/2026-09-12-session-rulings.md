# Session rulings — 2026-09-12 (bug batch)

Devin's rulings for the 2026-09-12 bug batch, recorded in writing in the batch spec
(`~/Inbox/plans/sasha-2026-09-12-bug-batch/spec.md`, "Rulings recorded this session"). R1 supersedes
`docs/decisions/2026-09-11-wave-3-4-rulings.md` line 18 (W3-7, relevance gate AC8); R2–R6 are copied
verbatim from that section.

## R1 — supersedes W3-7: catalog relevance gate is top-1 ≥ 82 %

Catalog relevance gate: **top-1 ≥ 82 %** (was 85 %), top-3 unchanged at 95 %. The Lane O measurement
(83.6 % / 100 %) therefore passes — measured by the driver 2026-09-12, not by the builder (receipts
below). `NEXT_PUBLIC_CATALOG_SEARCH` goes on in production once the catalog is imported there. "As
long as we have fuzzy search, we're good."

W3-7 ("**Stays OPEN** … The written 85/95 gate is not lowered") is superseded: the written gate was
lowered by Devin, in writing, on 2026-09-12. Everything else in W3-7 that is not the gate number
stands — the ranked list is what goes to her phone, and auto-resolve stays effectively off (the
calibrated pair is still 0.95 / 0.30).

Measured on production the same day: top-1 83.6 % / top-3 100.0 % (n = 61 of 66 labelled queries),
after the label `2026-09-12` import (13,694 foods) and `scripts/load-synonyms.ts` (67 rows). That
measurement — and the food and synonym counts it rests on — was the driver's, not this builder's; the
builder did not re-measure it. Receipts:
[`../catalog/receipts/2026-09-12-search-eval-production-run2.txt`](../catalog/receipts/2026-09-12-search-eval-production-run2.txt),
[`../catalog/receipts/2026-09-12-production-import.txt`](../catalog/receipts/2026-09-12-production-import.txt).
Full record: `docs/catalog/relevance.md`, "Gate lowered 2026-09-12 by Devin".

## R2 — coach on in production

- R2. Coach goes live for recommendations and questions, inside the Phase 7 tool set. Nous stays
  rejected (`docs/ai-data-handling.md`); the coach runs on Gemini once billing is confirmed.

## R3 — feature requests in this batch

- R3. Feature requests F-01 (water), F-02 (day toggle), F-03 (notes) enter this batch.

## R4 — health-context turns may reach paid Gemini

- R4 (Devin, 22:05Z, in writing: "YES"). Health-context coach turns (her profile carries
  ulcerative colitis, so that is every turn) may go to **Gemini on the paid tier**, once billing
  and prompt-logging are attested. Nous stays rejected. T4 ships the switch
  (`HEALTH_CONTEXT_PROVIDER=gemini` + `GEMINI_BILLING_ATTESTED=1`); T9 sets both in Vercel after
  the attestation. Update `docs/ai-data-handling.md` "Data sent" in the T4 PR: gut and condition
  notes may reach Gemini paid tier under R4; never an unpaid project, never Nous.

## R5 — Oura path B

- R5 (Devin, 22:05Z). Oura: path B — the OAuth app is registered under Sasha's own Oura
  account, with Devin at the laptop with her. Path A is not pursued.

## R6 — a recipe is a meal, so it obeys the domain rule

- R6 (driver, 2026-09-13 00:20Z, from the Sol second audit of T1). A recipe is a meal she
  plans, so it obeys the domain rule "no meal anywhere contains apple, gluten or dairy": the
  recipe sheet rejects an off-plan ingredient in both tiers (row stays visible and marked;
  tapping it says "Not on her plan (gluten)"). Logging stays "marking, never hiding". Main
  already allowed off-plan catalog rows into recipes; T1 closes that too.
