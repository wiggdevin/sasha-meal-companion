# FluidVoice UI recovery

Date: 2026-09-28  
Branch: `feat/ui-recovery`  
Status: design approved in chat; implementation requires written-spec review

## Purpose

Finish the recoverable Meal Companion UI requests dictated through FluidVoice on
2026-09-27 and 2026-09-28, preserve the already-shipped behavior that passed focused
verification, and release the completed UI once through the existing Git-to-Vercel
pipeline.

The phone remains the primary surface. Each interaction must be understandable without
instructions, work at 320 px, and preserve the dark liquid-glass design contract in
`DESIGN.md`. The change does not alter target authority, nutrition calculations, sync
ownership, schema, or production data.

## Evidence and authority

The requirement authority is the recovered FluidVoice corpus and the user's approval of
the one-branch design on 2026-09-28. The independent Opus audit reconstructed 42 rows:
the original A01-A15, X01, V01-V07 and F01-F09 rows plus T01-T10.

When sources disagree:

1. The later, more specific FluidVoice instruction wins.
2. A confirmed decision wins over an earlier proposed interaction.
3. Existing server/domain invariants win over presentation changes.
4. Missing screenshot context must not be invented; the request is mapped to the narrowest
   existing surface whose labels and behavior match the dictation.

## Release shape

Use one feature branch, one PR, one squash merge to `main`, and one Vercel production
deployment. Keep work reviewable as four logical commits before the squash:

1. `docs: specify fluidvoice ui recovery`
2. `feat: restore today interactions`
3. `fix: complete foods and recipe interactions`
4. `feat: finish action feedback and update prompt`

Tests for a behavior ship in the same commit as that behavior. No production migration is
required. Instacart, Uber Eats, retailer discovery, and live pricing remain a separate
provider track and do not block this UI release.

## Scope 1: Today

### Gauge layout and water input — T02, T03

- Render carbohydrates above water in the left column.
- Render protein above fat in the right column.
- Keep the existing gauge colors and calculation paths.
- Water supports the existing hold-and-drag gesture as well as accessible step controls.
- The drag target must have enough horizontal room that a user can set a large total in
  one gesture. Values remain bounded by the existing water model.

### Calendar expansion — T05, T06

- Keep the compact day strip as the default.
- Add a centered separator/handle between the day strip and macro region using an unused
  Today-section role color. It must read as a control, not decoration.
- A long press followed by a downward drag expands an inline month grid. Passing the
  threshold snaps the grid open; an upward flick or explicit close control collapses it.
- The month grid supports direct date selection through the existing `onSelect` path.
- Keyboard and assistive-technology users receive an ordinary button with
  `aria-expanded`, an accessible name, and the same open/close result.
- Reduced-motion mode removes the spring/slide while preserving the state change.

### Collapsible macro detail — T07

- Long-pressing the existing “Still to eat” region collapses or expands the macro detail.
- Add three stemless chevrons whose glow overlaps in sequence toward the destination.
  Implement this with CSS and design tokens; WebGL is unnecessary for three small marks.
- Preserve the current short divider. Do not extend it edge-to-edge.
- Provide an accessible button path and persist only for the current page session; a new
  visit begins expanded.

### Daily information card — T04

- Treat the removable item as the Today summary/information card nearest the gauges.
- A partial left swipe reveals Clear. Continuing beyond the full threshold dismisses it.
- Dismissal applies only to the viewed date and local account projection. The card returns
  on a new date. It does not delete logs or server data.
- Offer a visible button alternative for keyboard and screen-reader use.

### Compact meal cards — T08, U03

- The collapsed card shows meal name, time, calories, protein, carbohydrates, and fat.
- Macro values use the same semantic gauge colors as Today.
- The lower-right expansion affordance is visually part of the card surface.
- A single tap keeps the existing edit action. A double tap or the explicit affordance
  expands read-only detail.
- Expanded detail uses a compact table for serving/ingredient information and shows meal
  contribution beside consumed and remaining daily totals when those values are available.
- Expansion must not mutate eaten state, plan content, or history.

### Time entry — U05

- Replace time-choice dropdowns used by Today meal editing with a compact glass sheet.
- The sheet presents a finger-scrollable 15-minute wheel covering a full day.
- Direct keyboard entry and increment/decrement controls remain available.
- The sheet is visually opaque enough that background text cannot compete with its labels.

## Scope 2: Foods and recipes

### Food rows and add affordances — A04, A05, T09

- Tapping a food row opens its edit sheet.
- A left swipe reveals Remove; crossing the full threshold applies the neutral membership
  operation. Notes and history remain intact.
- Apply the behavior to role groups and Other foods.
- Every category card ends with the same slim, centered Add row.
- Avoids keeps the user's avoid list first, using the same card hierarchy as Favorites.

### Recipe discovery and ingredients — A03, A06, A07, U02, U04

- Recipe search remains the first control in the Recipes section.
- The search icon sits inside the field at the far right; click and Enter share one submit
  path.
- Cuisine, maximum minutes, and effort stay on one compact row at phone widths.
- The recipe ingredient editor ends with a row-shaped blank affordance matching existing
  ingredient rows, with minus/plus edges and muted “Add ingredient” copy. Activating it
  opens the existing ingredient search.
- Preserve New recipe and saved-recipe create/edit/delete behavior.

### Search correctness — A10, X01

- Add-to-Avoid search matches food names, aliases, common typos, and cuisine/category
  terms available in the catalog policy map.
- Recipe cuisine filtering uses normalized contains/family matching so “Italian” can match
  “Italian-inspired”.
- When a requested cuisine has no eligible recipes, return an explicit empty result with a
  clear filter-reset action. Do not surface `cannot_match_any_requests` as a generic error.
- Keep account rules and ingredient eligibility as hard constraints.

### Affected meals and Conditions — A09, A11

- Affected-meals review keeps its count, instance list, edit/remove/remix actions, and
  eaten-history protection.
- Add a free-text Ask Sasha field. It sends the user's own wording plus the bounded affected
  meal identifiers; fixed checkboxes remain optional shortcuts.
- Conditions save owns its own feedback state so a custom-rule action cannot trigger its
  glow.
- The Conditions success haptic rises quickly, then decays, with a total envelope near two
  seconds on browsers that support vibration.

## Scope 3: Composer, feedback, and PWA freshness

### Composer — V01-V06

- Preserve the verified Record → Stop → Review/Edit → Send state machine.
- Preserve continuous recognition restarts, retained words on page hide, IME-aware Enter,
  Shift+Enter, red pulse, and the 30-second recording ceiling.
- Resolve the cursor wording with the latest FluidVoice instruction: when the caret is at
  the end, Record is available beside Send; when it is inside the draft, show Send without
  Record. Enter sends when not composing. Clicking text only positions the caret and never
  submits.
- Spoken replies remain deferred to the native voice phase.

### App-wide feedback — F01-F09

- All enabled pressable controls use the shared 150 ms pressed treatment.
- Single-select controls expose a persistent selected state and `aria-pressed` or the
  equivalent semantic state.
- Successful writes use the shared glow and best-effort haptic.
- Failures never use success glow/haptics and present a red alert toast.
- Pending work is yellow; blockers are red; changes are violet for four seconds.
- Reversible writes expose a fading Undo while reversal is still safe.
- Finish the rollout on logging, eaten toggles, Favorites membership, notes, barcode/capture
  saves, Settings writes, onboarding writes, meal edits, and the Foods actions in this spec.

### Update availability

- Keep the service worker's current safe activation policy: do not force-reload open tabs.
- When an updated worker is waiting, display a small persistent “Update available” notice
  with a Reload action.
- Reload only after the user chooses it. Dismissal lasts for the current page session.
- `controllerchange` performs at most one reload and must not loop.

## State, ownership, and boundaries

- Today presentation state lives in client components and must not change the canonical
  plan or target revision.
- Date-scoped dismissal keys include account id, date, and card id.
- Expanded/collapsed presentation is ephemeral unless this spec explicitly says otherwise.
- Food removal continues through the existing durable membership operation.
- Recipe and Avoid searches use existing server/catalog boundaries; no third-party provider
  is added.
- All component colors come from design tokens or semantic roles. No raw color literals are
  permitted in `app/` or `components/`.

## Accessibility and interaction safety

- Gesture-only behavior always has a visible button alternative.
- Controls meet the 44 px target rule even when their visible mark is smaller.
- Expansion controls expose `aria-expanded`; dismiss controls identify the affected card;
  error and success messages use the existing live-region semantics.
- Double tap must not delay or suppress the existing single-tap edit path for keyboard
  users. The explicit expansion affordance is the reliable accessible route.
- Every animation respects `prefers-reduced-motion`.

## Error handling

- Gesture cancellation returns the surface to its prior position without applying a write.
- Failed membership, plan, log, or Settings writes retain local input and show the shared
  failure state.
- Search empty states are distinct from request errors.
- A service-worker registration or update error remains non-blocking and must not prevent
  app use.

## Test strategy

Use red-green TDD for every behavior. Focused tests must cover:

- gauge column order and water drag/step parity;
- month-calendar threshold, selection, close, keyboard, and reduced-motion paths;
- macro collapse/expand and daily card dismissal reset;
- meal-card collapsed content, single-tap edit, double-tap/explicit expansion, and macro
  role colors;
- 15-minute time control bounds and keyboard entry;
- food-row swipe including Other foods, Add footer, and durable neutral membership;
- recipe field/icon layout, ingredient add row, cuisine family matching, Chinese empty
  state, and conflicting-filter handling;
- Ask Sasha free text and affected-id bounds;
- Conditions feedback isolation and rise-then-decay haptic sequence;
- remaining feedback write surfaces and failure-without-success behavior;
- composer caret state and Enter behavior;
- service-worker waiting/update/reload-loop protection.

Before the PR, run once in this order:

1. Focused tests during development.
2. `pnpm lint`.
3. `pnpm exec tsc --noEmit`.
4. `pnpm test` exactly once locally.
5. `pnpm build`.

CI is the second full-suite run and the merge gate.

## Visual and production proof

- Render the signed-in UI at 320, 390, 430, and 1024 px.
- Exercise gesture and accessible-button paths.
- Use the approved pilot account for Recipes and Shopping.
- Capture Today collapsed/expanded states, Foods edits/search, feedback success/failure,
  composer caret states, and the update notice.
- After squash merge, wait for the Vercel deployment whose Git SHA equals `main`.
- Verify the production URL with the pilot account and record the deployed SHA and the
  acceptance results. Do not run `vercel --prod`.

## Out of scope

- Instacart, Uber Eats, retailer APIs, store discovery, and live/average pricing.
- New database schema or migrations.
- Spoken coach replies.
- Coach recommendation ranking, macro-gap prioritization, and later trend analysis from
  U01; those are functional coach changes rather than UI recovery.
- Changes to nutrition targets, eligibility rules, meal composition, or sync authority.
- Destructive cleanup of archived worktrees or local branches until the merged release has
  been verified and their content is accounted for.

## Completion criteria

The UI recovery is complete only when:

1. Every in-scope row above has a passing focused test and rendered evidence.
2. Lint, typecheck, the single local full suite, build, and CI pass.
3. The PR is squash-merged to `main`.
4. Vercel reports a production deployment for the exact merged SHA.
5. The signed-in production walkthrough passes on the approved pilot account.
6. The acceptance ledger distinguishes production proof from source-only proof.
7. Any stale branch or worktree cleanup happens only after the release evidence is saved.
