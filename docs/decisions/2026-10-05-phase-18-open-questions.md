# Phase 18 open questions: decisions (2026-10-05)

Source: `docs/specs/phase-18-open-world-foods.md` §12. On 2026-10-05 the owner delegated the
remaining Phase 18 decisions to the backend lane: take the recommended answer, get a quick GPT-6
Sol audit, and continue. The audit objected to Q3 and Q4; both objections are adopted below.
Nothing here replaces a review that names a human reviewer.

| # | Question | Decision |
|---|---|---|
| 1 | Launch geography | Apply the U.S. prior only to accounts that chose the U.S. Every other account gets the neutral prior. No state or region question. |
| 2 | Third-party data rights | Ship without FlavorGraph. Add UK Biobank liking aggregates only after their reuse terms are confirmed; until then the `like` term is absent. Never use FlavorDB, FooDB, Recipe1M+, RecipeNLG, Instacart, Kilts NielsenIQ or Food.com. |
| 3 | Universe and cuisine-tier sign-off | **A human review is required.** W1 may merge its code, data and an automated GPT-6 Sol evidence receipt, because the universe is inert while the W2b open-world gate is shut. W1's acceptance 4 (a named human reviewer) stays open until the owner records the review. The gate does not open before then. v1 ships only the cuisines that pass the W1 matrix with reviewed tiers. |
| 4 | Accounts with a stated condition | An account with a stated condition opens only after all three are true: a qualified clinical reviewer approves the condition wording, the owner approves the condition-pack wording (`CONDITION_PACKS_ENABLED` stays off until then), and the user confirms each condition in that reviewed wording. Until then the account stays closed. |
| 5 | Existing accounts | The first client stays held (`pref-0`, no invitation). Other existing accounts are invited only after the safety and plausibility gates pass. Their Eats marks become Favored marks when they opt in. |
| 6 | Offline safety | Show the last plan offline and withhold new suggestions until the rule revision is confirmed fresh. |
| 7 | Cross-user learning (T3) | Out of scope. It is revisited only after the personal model is proven, with its own consent and privacy design. |
| 8 | Shopping gate | W11 and W12 stay pilot-only until the shared recommendation score and the confirm-first pantry flow pass their release checks. |

Audit record: `~/.claude/goal-state/sasha-phase18/reviews/decisions-q1-8-sol.md` (Q1, Q2 and Q5–Q8
agree; Q3 and Q4 objections adopted).

Owner actions still open: the universe and cuisine-tier review (Q3), and the condition-pack wording
review (Q4).
