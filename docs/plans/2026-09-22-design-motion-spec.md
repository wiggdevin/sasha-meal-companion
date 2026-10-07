# Design "Motion" — spec (2026-09-22)

Owner: Devin. Branch `feat/design-motion` (off `feat/ui-edits`; lands after `feat/ui-edits`,
`feat/tdee-bodyfat`, `feat/tdee-rate-goals`). Supersedes the two-theme idea in
`2026-09-22-design-restyle.md`: **one theme, no switch.** The old look is archived at
`docs/design/archive/natural-2026-09-22/` and tag `theme-natural-2026-09-22`.

## Rulings from Devin (2026-09-22)

- Re-skin: every screen, flow and component stays; the token layer, surfaces, motion and ground
  change. Coach page also gets the converse chat box.
- Dark-only, exactly the reference (vikod3/motion-portfolio): black ground `0 0% 0%`, foreground
  `0 0% 95%`, white primary, card 5 %, secondary/accent 10 %, muted 8 %, muted-foreground 60 %,
  border/input 15 %, ring white, radius 0.75rem. Light mode: none.
- Background: code-only "quiet dark" ground — two slow grey radial glows (6–10 %) over black plus
  a faint film-grain overlay, still under reduced-motion (the look of MotionSites *Futuristic
  Cinematic* without its WebGL dependency). No video, no Unicorn Studio, no new dependency.
- Chat box: `src/components/hero/chat-input.tsx` from vikod3/converse, coach page only, with the
  existing composer's real actions (camera, mic left; send right). Nothing else from converse.

## Source of truth

- `DESIGN.md` (root) is rewritten from the motion-portfolio tokens; `app/design-tokens.css` is its
  `design.md export --format css-tailwind` output; `app/globals.css` carries the surfaces.
- Token names stay **semantic** (`background, foreground, card, muted, primary, border, ring` +
  `gauge-calories/protein/carbs/fat/water`). No hard-coded hex in `components/` or `app/`: the 56
  files carrying hex are swept onto tokens, and an ESLint rule (`no-hardcoded-color`) keeps it so.
- Gauges: white primary with four greys is not enough to tell five dials apart, so the gauges keep
  one hue each at low saturation on black; exact values are set in step 3 and shown before use.

## Steps (each: tests green, tsc, lint, snapshots updated with the change)

1. Archive + branch (done). Sweep hex → tokens with **zero visual change**; add the lint rule.
   **Done 2026-09-22:** 250 literals in 59 files → tokens. New role colours in `app/globals.css`
   `@theme` (`on-primary, icon, icon-off, text-hint, warning, caution, well-dark`) and role
   recipes in `:root` (`--grad-ink/card/sheet/sheet-shell/bubble/olive/gold/fab`,
   `--shadow-button/card`, `--ink-rgb`, `--on-olive-rgb`, `--charcoal-deep-rgb`). ESLint
   `no-restricted-syntax` bans hex and tinted `rgb()` literals in `app/` and `components/`
   (neutral black/white alpha still allowed — step 3 decides). The browser `themeColor` lives in
   `lib/design/theme-color.ts` (metadata needs a literal). Proof of zero change: every token
   resolves in the browser to its old value (22 colours, 2 shadows, 4 gradients checked on
   /settings); snapshot diffs are colour substitutions only, checked mechanically.
   **Step 2 therefore edits token values only** — `app/design-tokens.css`, the two blocks above,
   `lib/design/theme-color.ts` — plus `DESIGN.md`.
2. `DESIGN.md` + tokens + `globals.css` rewritten to the Motion palette; the quiet-dark ground
   replaces `BackgroundVideo`; typography from the reference (Inter or system, tight tracking).
   **Done 2026-09-22.** `DESIGN.md` rewritten (lint: 0 errors, the same 27 "unused in a component"
   notes as before) and exported to `app/design-tokens.css` (same shape, values only). `globals.css`:
   Motion values for every legacy and role token; surfaces on the reference's liquid glass (white
   6 %, 12 % hairline, 48 px blur); `.ground-layer` (two drifting 6–9 % white glows + 5 % grain,
   pure CSS) replaces `BackgroundVideo` (deleted; archived). Typography: the reference uses the
   system font, which the app already does — no change. Component fixes the inversion needed:
   `--grad-ink` split into primary fill (white, `on-primary` black) and `--grad-panel` (dark panel);
   sheet scrims → `bg-scrim`; toasts, check tick, record button, rest tile, coach button follow
   `on-primary`; selected chips → `--color-selected`/`--color-on-selected`, selected option cards →
   `--color-selected-soft`; `--highlight` for inner edges; manifest, theme colour and iOS status bar
   (`black-translucent`; every screen already pads `--safe-top`). Checked in the browser: Today,
   Settings, Foods, Coach, Body and the Log-a-food sheet.
   Noted for step 3: the coach button floats over an open sheet's search field (layering, not
   colour); weights are still the old 300/400 (the reference leans 500/600).
3. Surfaces: cards, sheets, tab bar, buttons, pills, dials — one calm direction per screen shown to
   Devin before it is built (Today first, then Foods, Body, Coach, Settings, Onboarding).
4. Coach: `components/coach/ChatComposer.tsx` in the converse shape.
   **Done 2026-09-22** (in place, not a new file): `components/coach/Composer.tsx` is the converse
   box — one rounded-3xl glass form, visible label + field on top, a row beneath with the attachment
   buttons (Scan, Camera, Weigh in) and the mic as round white circles on the left and a round white
   Send on the right (`components/coach/round-button.tsx`). Weigh-in opens above the box. The mic is
   red while it records. converse's "+" and "edit" buttons have no job here and were not copied.
5. `CONTEXT.md` design terms updated; `docs/features.md` rows touched only where copy changes.

## Constraints

- No person's name in runtime code (`tests/tenancy`). `PAGE_EFFECTS` budget unchanged.
- Pure UI: no Grok / DeepSeek / GPT lane. Screenshots to `~/Inbox/screenshots/design-motion/`.
- One push when Devin says "land it".
