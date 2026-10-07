# Foods, Avoids and Shopping: 15 annotations

User approved listing and implementing these changes on 2026-09-27. All items start UNVERIFIED. A check is complete only with source/test/browser evidence and two independent yes/no verdicts; lack of evidence is NO, not presumed success. Visual review: Gemini 3.8 Flash plus an independent available reviewer (user-approved substitute after Kimi K3 credits were exhausted); complex review: Opus via subscription; binary evidence review: Jev. Root Astra final audit and CI gate before release. Model unavailability must be reported honestly, never simulated. Keep changes minimal and preserve account isolation and actual intake history.

Base main: aa7946c15c6a5754cca7ebc7e47296329c25a342. Working branch feat/foods-annotations. Composer is separately owned at /Users/zero-suminc./.codex/worktrees/sasha-composer/meal-companion; shared outcome feedback separately owned by chat 01a0e51e-9d66-72f3-98dc-de0624a77d9a. No editing their worktrees or restarting their servers. Parent owns integration/commit/release.

## A01 — Diet style editing
- [ ] Tap card opens an editor for diet style and exclusions; values editable freely.
- [ ] Explicit confirmation previews change; cancel preserves current values.
- [ ] User and coach AI use consistent validated, owner-scoped persisted values.
- [ ] Reload and suggestions reflect the change; other users remain unchanged.

## A02 — Cooking effort selector
- [ ] Replace unreadable native menu with accessible, high-contrast glass-styled scrollable choices.
- [ ] Touch, keyboard, selected value, focus and screen-reader labels work.

## A03 — Compact recipe filters
- [ ] Cuisine, max minutes and effort use compact fields in one row where usable.
- [ ] At minimum minutes and effort share a mobile row; no clipped text/overflow or tiny tap targets.

## A04 — Edit and remove food rows
- [ ] Existing tap modal supports real edits with saved feedback and reload persistence.
- [ ] Swipe left reveals remove/clear consistently for entries; explicit accessible equivalent exists.
- [ ] Removing membership does not destroy canonical shared food data or consumed history.

## A05 — Add within category cards
- [ ] Every usual-food category card has a thin full-width clickable footer with centered Add.
- [ ] Add opens appropriate food flow and lands in the intended category; empty cards work.

## A06 — Recipe discovery placement/search control
- [ ] Move discovery to the start of Recipes below usual foods, not above Favorites.
- [ ] Search icon is inside far-right end of input; accessible label and Enter submit work.

## A07 — Recipe creation and CRUD
- [ ] Separate New recipe action opens current creation modal/sequence.
- [ ] Search, compact filters, saved recipes appear together in Recipes.
- [ ] Account-owned saved recipes can be stored, edited and deleted; catalog originals remain immutable.

## A08 — Custom food rules
- [ ] Free-text custom rule can be added, persisted, edited and removed.
- [ ] Interpret supported ingredient/cuisine exclusions consistently throughout recommendations.
- [ ] Unsupported/ambiguous guidance is explicitly distinguished from enforced exclusion; no false safety promise.

## A09 — Conditions submission feedback
- [ ] Explicit submit icon and Enter save conditions; no accidental save merely on blur.
- [ ] Successful saved action gets brief glow; errors preserve input and show failure, never success glow.
- [ ] Approximate 2-second rising/decaying haptic envelope where platform supports it; visual fallback and reduced motion.

## A10 — Avoid-food search
- [ ] Reproduce empty search bug (e.g. bean); repair data/API path rather than cosmetic hiding.
- [ ] Semantic aliases, partial names and typo-tolerant matches produce useful food/ingredient results.
- [ ] Selecting persists into Avoids; reload, suggestions and account isolation verified.

## A11 — Avoid card and affected-plan resolution
- [ ] Avoid-food card at top, matching Favorites; thin bottom Add footer.
- [ ] Search ingredient/cuisine intent without silently treating cuisine as an exact ingredient.
- [ ] New avoid scans existing future plans/cards; blocked candidates cannot remain actionable as safe suggestions.
- [ ] Exact per-avoid affected count appears in restrained red glass badge; click opens instance details.
- [ ] User can edit/remove/remix affected future meal instances inside modal; gestures left remove/right remix plus accessible controls.
- [ ] Ask Sasha context supports targeted replacement suggestions (e.g. next week's meals 15/16) and similar options.
- [ ] Relevant setting conflicts can be edited in the modal without navigating away.
- [ ] Preserve logged actual intake/history; audit affects future planning, not historical facts.

## A12 — Optional shopping location/currency
- [ ] User can plan/save without supplying either; no duplicate mandatory currency field.
- [ ] Coarse location/ZIP/address optional; Use my location only after explicit user tap/browser permission.
- [ ] Nearby stores can be selected singly/multiply using real available provider data.
- [ ] Prices only from actual usable store/product provider with provenance/freshness; no invented quotes, no exact-bill guarantee.
- [ ] If provider unavailable, document exact external blocker and preserve useful location/store preference flow; never mark price discovery implemented without proof.

## A13 — Consistent dropdowns app-wide
- [ ] Inventory dropdowns and use shared glass scroll selector across UI, preserving semantics.
- [ ] Check touch, keyboard, contrast, portal/overflow, disabled/error states, responsive sizes.

## A14 — Shared component library
- [ ] Reusable selector in existing component library, documented and tested.
- [ ] Consumers use it rather than parallel copies; exact options/values remain compatible.

## A15 — Saved shopping lists and error
- [ ] Reproduce reported planning/population failure and fix root cause.
- [ ] Generate, save, list/reopen, edit and persist shopping lists.
- [ ] Checked items, notes, manual entries and locks survive reload and replanning.
- [ ] Helpful recoverable empty/error states, no false saved message; other users remain isolated.

## Cross-cutting recipe evidence failure
- [ ] Reproduce screenshot: cuisine American, max minutes15, effort Any.
- [ ] Separate unavailable evidence from true avoided food or no candidate; do not weaken dietary safety.
- [ ] Fix legitimate mapping/DB access failure causing Cannot check preferences/restrictions spam.
- [ ] Surface concise actionable reason; detailed diagnostics do not flood user UI.
- [ ] Production legacy rule-review prerequisite is explained, with link to review, rather than generic409.

## Scope decisions
Use existing app architecture and PWA. No native wrapper, new vendor purchase, fabricated grocery pricing or silent bypass of dietary rules. Use scoped CSS additions to avoid composer/feedback conflicts. Root applies reviewed migrations only after local proof. No production test accounts or personal data edits.
