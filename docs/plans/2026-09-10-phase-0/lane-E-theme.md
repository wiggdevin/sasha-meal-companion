# Lane E — NeuForm theme (restyle, no behavior change)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Re-skin every existing screen to the NeuForm material defined in `DESIGN.md` (light glass, olive + beige, Arena gauge, charcoal meal cards) without changing any behavior or data shape.

**Architecture:** Tokens come from `DESIGN.md` via the exported `app/design-tokens.css` (`@theme` block). `app/globals.css` keeps every existing token NAME (Lanes B and C reference them) and remaps their values; new tokens are added, none removed. Components are restyled one at a time with a screenshot gate per screen. The video ground is removed.

**Tech Stack:** Next.js 16, React 19, Tailwind 4 (`@theme`), `motion` for the card entrance and gauge draw, vitest.

**Spec:** `DESIGN.md` (the contract) + the canvas mockups: https://claude.ai/code/artifact/5ede6ed6-7dcf-4af4-9f03-7120bcb16e51 (working files: `~/Desktop/Sasha app/07-design/neuform-mockup/*.dc.html` — copy exact values from them).

## Global Constraints
- Owns: `DESIGN.md`, `app/design-tokens.css`, `app/globals.css`, `app/layout.tsx` (ground/body only — do NOT add AuthGate; Lane B's hand-off owns that), `app/page.tsx` (className/markup only), `app/foods/page.tsx`, `app/week/page.tsx`, `app/settings/page.tsx` (styling), `components/Ground.tsx` (delete), `components/MacroRings.tsx`, `components/SlotCard.tsx`, `components/TabBar.tsx`, `components/Sheet.tsx`, `components/QuickActions.tsx`, `components/Stepper.tsx`, `components/MyFoods.tsx`, `components/FoodsReference.tsx`, `components/LogFoodSheet.tsx`, `components/BuildMealSheet.tsx`, `components/AddFoodSheet.tsx`, `components/FoodSheet.tsx`, `components/SwapSheet.tsx`, `components/NoteSheet.tsx`, `components/LoggedExtras.tsx`, `components/ScaleWarning.tsx`, `components/RampControl.tsx`, `components/ShiftTimes.tsx`, `components/WeekGrid.tsx`, `components/InstallPrompt.tsx`, `components/ShareButton.tsx`, `components/IcsSubscribe.tsx`, `public/manifest.webmanifest` (theme colours), `public/icons/*`, `docs/screenshots/theme/*`.
- Never touches: `lib/**`, `app/api/**`, `components/SyncBootstrap.tsx`, `components/SyncStatus.tsx`, `components/AuthGate.tsx`, `app/sign-in/**`, `app/auth/**`, `components/ServiceWorkerRegistrar.tsx`, `public/sw.js`.
- No token is renamed or removed from `app/globals.css`; values change, names stay; new names are added.
- Every existing test stays green; `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` green before the PR. TDD where a pure function exists (gauge geometry); visual gates elsewhere.
- Branch `feat/p0-theme`. Conventional commits, no AI attribution.

## File structure
| File | Responsibility |
|---|---|
| `app/design-tokens.css` | Exported `@theme` from `DESIGN.md`; regenerate with `npx --yes -p @google/design.md@0.3.0 design.md export DESIGN.md --format css-tailwind > app/design-tokens.css`; never hand-edit. |
| `app/globals.css` | Imports `design-tokens.css`; remaps legacy names (`--color-paper`, `--color-charcoal`, `--color-fog`, `--color-graphite`, `--color-hairline`, `--color-signal`, `--color-plum`, `--color-sky`, `--color-green`, `--color-muted`, radius/typography tokens) onto the new values; utility classes `.shell`, `.surface`, `.pill`, `.pill-in`, `.well`, `.olive-panel`, `.meal-card`, `.tab-glass`, `.ts` exactly as in the mockup `<helmet>` styles. |
| `lib/gauge.ts` (new, pure, allowed exception in `lib/`) | `arc(r, pct)` → `{circumference, dashoffset}`, `tracer(cx, cy, r, pct)` → `{x, y}`, `ticks(cx, cy, rIn, rOut, n)` → line coords. |
| `components/MacroRings.tsx` | Arena gauge: 300 px hero (calories) + three 100 px minis (protein, carbs, fat), colours from tokens, tracer dot, "Still to eat" block. Same props as today. |
| `components/SlotCard.tsx` | Glass card; eaten state = ink check circle + strikethrough; Eaten / Swap / Add note controls per mockup. |
| `components/TabBar.tsx` | Floating pill glass bar, 64 px, 4 items. |
| `components/Sheet.tsx` | Sheet = shell top corners 32 px, 96 % white glass, 12 px blur, grabber. |
| `app/page.tsx` | Header (40 px display, day-type pill), gauge card, olive note card, Plan list, Also today grid, FAB. |
| `app/foods/page.tsx` + `MyFoods.tsx` | Eats/Avoid toggle pill, search well, meal cards (charcoal in olive shell, 118 px photo strip placeholder) and grouped glass lists with role dots. |
| `components/Ground.tsx`, `public/ground-v1.mp4` | Deleted; body background `#F5F5F3`; `html` gradient fallback removed; service worker precache list updated to drop the mp4 (the sw file is not this lane's — leave a note in the hand-off). |

### Task 1: Tokens and utilities
**Files:** Modify `app/globals.css`; Create `app/design-tokens.css` (exported); Test `app/globals.test.ts` (new: reads globals.css and asserts every legacy token name still exists).
- [ ] Write `app/globals.test.ts`: read the file, assert each of the legacy names above appears as `--color-…:`; run → PASS today (baseline), keep it as the guard.
- [ ] Add `@import "./design-tokens.css";` at the top; remap legacy names to DESIGN.md values (`--color-paper: #F5F5F3`, `--color-charcoal: #2B2B2B`, `--color-fog: #FFFFFF`, `--color-graphite: #4A4A4A`, `--color-muted: #6B6B6B`, `--color-hairline: rgba(0,0,0,0.06)`, `--color-signal: #F97316`, `--color-plum: #3B82F6`, `--color-sky: #6B7059`, `--color-green: #FBC336` — keep the names, note the meaning shift in a comment); add the utility classes copied from the mockup helmet styles.
- [ ] `pnpm test app/globals.test.ts` → PASS; `pnpm build` → PASS. Commit `feat(theme): design tokens and glass utilities`.

### Task 2: Ground and body
- [ ] Delete `components/Ground.tsx` and its import in `app/layout.tsx`; body class → `bg-paper text-charcoal`; remove the `html` gradient fallback; `public/manifest.webmanifest` `theme_color`/`background_color` → `#F5F5F3`. `pnpm build` → PASS. Commit `feat(theme): light ground, remove flame video`.

### Task 3: Gauge geometry (TDD)
- [ ] `lib/gauge.test.ts`: `arc(124, 0.42)` → circumference 779.1 ± 0.1, dashoffset 451.9 ± 0.1; `tracer(150,150,124,0)` → (150, 26); `ticks(150,150,132,146,60)` has 60 entries, first is vertical at top. Run → FAIL. Implement `lib/gauge.ts`. Run → PASS. Commit `feat(theme): gauge geometry`.

### Task 4: MacroRings → Arena gauge
- [ ] Rebuild `components/MacroRings.tsx` from `Main.dc.html`'s gauge card (hero 300 px, minis 100 px, eyebrows, "Still to eat" line, corner brackets); props unchanged; colours from tokens; `motion` draws the arc once (1.2 s ease-out) and respects reduced motion. Existing tests green. Screenshot `docs/screenshots/theme/today-gauge.png` via the dev server. Commit `feat(theme): arena gauge`.

### Task 5: Today screen
- [ ] `app/page.tsx` + `SlotCard.tsx` + `QuickActions.tsx` + `LoggedExtras.tsx` + `ScaleWarning.tsx` + `RampControl.tsx`: match `Main.dc.html` (header, day-type pill, olive note card, Plan cards with eaten/pending states, Also-today grid, FAB). Screenshot. Commit `feat(theme): today screen`.

### Task 6: Tab bar and sheets
- [ ] `TabBar.tsx` (floating pill glass), `Sheet.tsx` (glass sheet with grabber), `Stepper.tsx` (pill stepper, 44 px targets), `LogFoodSheet.tsx` per `LogMeal.dc.html` (capture pills row is present but disabled until Phase 4: render with `aria-disabled` and 50 % opacity). Screenshot. Commit `feat(theme): tab bar and sheets`.

### Task 7: Foods, Week, Settings
- [ ] `app/foods/page.tsx`, `MyFoods.tsx`, `FoodsReference.tsx`, `FoodSheet.tsx`, `AddFoodSheet.tsx`, `SwapSheet.tsx`, `BuildMealSheet.tsx`, `NoteSheet.tsx` per `Foods.dc.html` (Eats/Avoid pill toggle, meal cards, grouped glass lists with role dots); `app/week/page.tsx` + `WeekGrid.tsx` and `app/settings/page.tsx` + `ShiftTimes.tsx`, `IcsSubscribe.tsx`, `ShareButton.tsx`, `InstallPrompt.tsx` restyled with the same recipes (no mockup exists — apply the system: glass cards, olive for emphasis, ink primary button). Screenshots for each. Commit per screen.

### Task 8: Accessibility and motion pass
- [ ] Every interactive element ≥ 44 px (grep for `h-10`/`h-9`/`w-9` and fix); contrast: no `#767676` on body text; `prefers-reduced-motion` disables the entrance and gauge animation. Run the existing tests, lint, tsc, build. Commit `feat(theme): a11y and motion pass`.

## Lane exit gate
`pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build` green; `docs/screenshots/theme/` has today, foods, week, settings, log-sheet, sign-in-less shots; Devin opens the Vercel preview on the phone and compares with the canvas.

## Hand-off to integration
- `public/sw.js` precache still lists `ground-v1.mp4` — the integration branch removes it (not this lane's file).
- Lanes B and C style `sign-in`, `AuthGate`, `SyncStatus` with the `.shell/.surface/.pill/.well` utilities and the ink button recipe from `app/globals.css`; they must not define their own colours.

## Open questions
1. Week screen has no mockup; the plan applies the system by rule. Devin may want a canvas artboard first.
2. Meal-card photos: no photo source exists yet; the placeholder plate ships until a photo feature is scoped.
