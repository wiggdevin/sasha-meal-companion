# Design restyle — complete change of visual style (logged 2026-09-22)

Owner: Devin. Status: **logged, not started.** Supersedes the current look in `DESIGN.md`
once work begins; `DESIGN.md` and `CONTEXT.md` are rewritten as part of the job, not before.

## The decision

Change the app's design style completely, from two named references:

1. **Main theme — motion-portfolio.** Everything (colours, type, radius, surfaces, motion,
   navigation, cards) comes from this one.
   - Lovable: https://lovable.dev/projects/11d74acf-92c0-47ef-859d-3f316ba8d3d3?remixed=true
   - Repo: https://github.com/vikod3/motion-portfolio.git
   - Source snapshot (from Devin's zip `921e0eb5-…`): `~/Inbox/misc/sasha-design-sources/motion-portfolio/`
2. **AI chat box only — converse.** Take the chat input box from this design and **nothing
   else** (not its hero, marquee, navbar, feature cards, or tokens).
   - Lovable: https://lovable.dev/projects/3e5c5bb3-45d2-499d-bfcc-2b54636e7b8f
   - Repo: https://github.com/vikod3/converse.git
   - Source snapshot (from Devin's zip `f2d85091-…`): `~/Inbox/misc/sasha-design-sources/converse/`
   - The one component: `src/components/hero/chat-input.tsx` — a rounded-3xl, `backdrop-blur`
     glass form with the text field on top and a bottom row of round white icon buttons
     (add, edit, send). Restyle it with motion-portfolio's tokens; keep its shape.

## What the theme source contains (read before starting)

- `src/index.css`: shadcn-style HSL tokens, pure black background (`0 0% 0%`), near-white
  foreground (`0 0% 95%`), white primary, 5–10 % greys for card / secondary / accent, 15 %
  borders, `--radius: 0.75rem`. Light and dark blocks are identical (a dark-only theme).
- `tailwind.config.ts`: standard shadcn colour mapping; check `fontFamily` and `keyframes`.
- Components of note: `HeroSection`, `VideoBackground` (`public/videos/background.mp4`),
  `UnicornStudioBackground` (third-party animated background — decide whether it belongs in a
  meal app before copying), `MarqueeText`, the card set under `src/components/features/`.

## Constraints that still hold

- UI work lives in `components/` and `app/`; never a person's name in runtime code
  (`tests/tenancy`). Read the rewritten `DESIGN.md` and `CONTEXT.md` before touching a
  component.
- This is a pure UI change: no Grok / DeepSeek / GPT audit lane (Devin's standing rule).
- The Settings markup snapshots and `PAGE_EFFECTS` budget will move; update them with the
  restyle, not around it.
- It lands after the current branches (`feat/ui-edits`, `feat/tdee-bodyfat`,
  `feat/tdee-rate-goals`) so it does not collide with their component edits.

## Open questions for Devin (ask once, at the start of the job)

- Keep the dark-only theme as-is, or add a light mode derived from it?
- Does the animated/video background come across, or only the tokens and components?
- Which screen gets the chat box first: the coach page only, or also a Today entry point?
