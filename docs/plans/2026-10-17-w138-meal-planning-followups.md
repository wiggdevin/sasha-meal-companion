# W138 — meal-planning follow-ups t20 and t22, and where cached facets are read

Status: closed with this note, no code. Checked against `main` at 31b041b (2026-10-17).

## t22 (O3 gate prerequisites): closed as owner-gated

The occasion calibration constant in `lib/foods/occasion-calibration.data.ts` stays `null`, so v2
occasion scores abstain and never reach ranking (`lib/foods/occasion-gate.ts`, Acceptance 9).
Nothing in code is left to build. Two owner steps remain, in order:

1. The owner reviews the human holdout for plausibility of plates per cuisine.
2. Then `pnpm exec tsx scripts/eval/facets-occasion-eval.ts --live --freeze` (bills TypeSafe, never
   in CI) writes the calibration.

Until both pass, the constant stays `null` (abstain). Jev stays off the allergy, diet and religion
paths (`tests/policy/facet-escalation-removal.test.ts`, `tests/policy/diet-rule-jev-removal.test.ts`).

## t20 (O4 gaps): closed with a pointer

The remaining O4 gap is `compose_meal` on the `lib/meals` engine (pinned foods, an incomplete named
draft result). It is tracked as **W156** (`docs/plans/2026-10-10-priority-spec-list.md`); the
four-food-term cap stays and regional priors are deferred (OD26). Nothing else is open under t20.

## Do cached facets reach coach grounding and `/api/log/commit`? Yes

Every path reads the cache through `loadSuggestionEvidence` (`lib/coach/suggest-policy.ts:71`, the
cache read via `readFacets` at about line 175, alongside stored allergen evidence and the user's
checks). A failed facet read is "could not be checked", never empty evidence.

| Path | Where it reads facets |
|---|---|
| Log commit policy | `lib/server/log.ts:204` (`policyIssues`) calls `loadSuggestionEvidence`; `app/api/log/commit/route.ts:44-52` warms a newly created account food's facets after the response |
| Coach log actions | `lib/coach/log-policy.ts:190` |
| Coach plan items | `lib/coach/plan-item-policy.ts` (same cache-only evidence, fails closed) |
| Coach reply check | `lib/server/reply-check-ports.ts:28` |
| Suggestions and eligible Eats | `lib/server/eligible-foods.ts:123` |
| Coach sanity | reads no facets (`lib/server/coach-sanity.ts`); it checks amounts, not policy |

## Why the sync log-ops outbox path does not warm facets

`lib/server/sync-log-ops.ts` applies phone-queued log writes and has no facet warm of its own. It does
not need one: an account food reaches `/api/log/commit` (which warms it, above), and the daily
Eats warm (`lib/server/eats-facet-warm.ts`, run by `app/api/jobs/facet-warm`, scheduled in
`vercel.json`) walks each account's Eats list and warms whatever is uncached. A food logged through
the outbox is therefore warmed by the Eats cron, and until then policy reads treat missing facets
as "not verified", not as allowed.
