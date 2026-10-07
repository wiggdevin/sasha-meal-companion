# Plan review: A08, A11, A12, account isolation and safety bypass

I reviewed the plan text only. I did not read the codebase, so the findings below come from the design, not from the code.

## Blockers to resolve before implementation

1. **A12 price discovery will probably be blocked.** Real store prices need a product/price API such as Kroger's, or a partner API such as Instacart's. Real nearby stores need a places API. Each one needs a signup, terms acceptance or billing. The plan says "no new vendor purchase", and the house rule says a new vendor needs Devin's approval. Plan for this outcome from the start: ship the optional location and store-preference flow, and mark price discovery BLOCKED with the exact provider and the step it needs. If no store provider is approved, store selection falls back to free-text store names. Do not seed store lists from model output or scraped guesses.
2. **A08 and A11 need one server-side enforcement point.** Both items require the same exclusion result everywhere. The cross-cutting "Cannot check preferences" failure suggests there are several evaluation paths today. The minimal fix is one function, `evaluate(candidate, owner) → safe | blocked(reasons) | unverified(reason)`. Every path must call it: suggestions, recipe search, plan generation, remix, Ask Sasha replacements, shopping-list population and every accept action. If one path skips it, the avoid is silently bypassed. This is a choke point, not a new architecture.
3. **Ask Sasha replacement may overlap the composer's worktree.** A11's "Ask Sasha" replacement context may touch the composer/chat surface, which is owned separately. Confirm the boundary with the parent before starting.
4. **Shared plans are undefined.** If plans or shopping lists can be shared (household, coach), the plan must say whose avoids apply to a shared instance. Without that, A11 either leaks one user's avoids to another user or misses them.

## A08: custom rules
- Store three things per rule: the raw text, the parsed result (canonical ingredient or cuisine IDs), and a status of `enforced`, `advisory` or `unparsed`. Set a rule to `enforced` only after the user confirms the parsed interpretation shown in the UI.
- An LLM may propose the parse but must not be the enforcer. Enforcement uses canonical IDs only.
- Treat these as `advisory` until the user edits them into a supported form: negations and exceptions ("no dairy except butter"), quantities, and conditions such as "low-FODMAP-ish".
- Label advisory rules in the UI as "guidance, not filtered". Never use check or shield styling on them.
- The derivative and synonym map must be conservative: whey and casein count as dairy, peanut oil counts as peanut. If ingredient data for a candidate is missing, the result is `unverified`, never `safe`.
- A10's fuzzy or typo matching is for search only. The avoid the user saves is the specific canonical item they picked. For example, "bean" asks the user to choose between green bean, legume and coffee bean.
- Editing a rule re-derives its parse and resets status to unconfirmed. Deleting one rule removes only that rule.
- When rule text goes into Sasha's prompt, pass it as quoted data, not as instructions (prompt-injection risk).

## A11: affected plans and replacements
- **Compute "affected" when data is read, from the enforcement function.** Do not run a one-time scan that writes a flag. A written flag goes stale when avoids, plans or diet style change, and a stale flag either shows a wrong count or leaves blocked meals actionable. The badge count is the number of affected instances, computed from that same function.
- **Scope:** only the owner's future plan instances that have not been logged. Define "future" in the user's time zone. For today, meals already logged are out of scope and unlogged ones are in.
- **History:** intake logs are never changed. A remix creates a new plan instance or replaces an unlogged one. It must not change a logged record or a recipe it references. Add a test that logs a meal, adds a conflicting avoid, and asserts the log is byte-identical afterwards.
- **"Cannot stay actionable":** the Cook, Accept, Add to shopping and Swap-in actions re-check on the server at action time, not only when the list renders.
- **Replacements** from Sasha and from similar-options must pass `evaluate` against all avoids, diet style and rules before they are shown, and again when accepted. Targeted requests such as "next week's meals 15/16" resolve to explicit instance IDs, owner-checked, with a preview and a confirm step. Never pick by fuzzy position.
- **Removing an avoid** unblocks the affected instances. It does not restore instances the user already removed or remixed.
- **Shopping lists (A15):** items that conflict with a new avoid on checked or locked lists are flagged, not silently edited.
- **Cuisine avoids** match the recipe's cuisine tag, not ingredient text. A recipe with no cuisine tag is `unverified` against a cuisine avoid.
- **Swipe-to-remove** needs undo, or a confirmation, plus the accessible button equivalent.
- **Settings edited in the modal** use the same validated, owner-scoped endpoint as A01. Do not add a second write path.

## A12: shopping location and pricing
- A price is shown only with its provenance: provider, store ID, product ID, match confidence, unit and fetched-at time. Set a stale time-to-live and hide or label prices older than it.
- Model-generated or estimated prices are never allowed.
- An unmatched item shows "no price", never $0.
- A total is labeled partial ("7 of 12 priced") and never mixes currencies. With no provider, show no total at all.
- Location is used only after an explicit tap. Store a coarse ZIP or area, not lat/long, unless it is needed. Do not send location to the LLM. The user can clear it.
- The provider cache of public prices and products can be shared across users, but its keys must not link to users. Store selection and location are per user.

## Account isolation
- Every new table (rules, saved recipes, shopping lists, store preferences) gets an owner column and RLS.
- Every new or changed endpoint gets a two-user test that covers read, update, delete and count, including a check that user B's avoids never change user A's badge.
- Service-role paths (the affected scan, Sasha tool calls, shopping generation) bypass RLS, so they must filter by owner explicitly. Instance IDs supplied by the model get an ownership check before any read or write, to prevent IDOR.
- Removing an A04 membership deletes only the user's link to the food, never the canonical food or anyone's history.

## Silent-bypass guards (cross-cutting)
- Fixing the "Cannot check" spam must not turn failures into passes. An evidence or DB failure gives `unverified`, which is shown as a single concise message and excluded from "safe" suggestions.
- Add one regression test that forces an evaluation error and asserts the candidate is not presented as safe.
- The legacy rule-review 409 is fixed by a clear message and a link to the review. Do not auto-approve or skip legacy rules to make the 409 go away.
- Wording audit: nothing in the UI or in Sasha's replies says "safe" or "allergen-free" for advisory rules or unverified candidates.

Verified response model: claude-opus-5-5
