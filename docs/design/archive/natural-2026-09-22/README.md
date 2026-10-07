# Archived theme — "Natural" (retired 2026-09-22)

The light linen / moss / glass look the app shipped from 2026-09-18 to 2026-09-22. Kept here, and
as git tag `theme-natural-2026-09-22`, so it can be brought back; nothing in `app/` or
`components/` reads from this folder.

| File | Was |
|---|---|
| `DESIGN.md` | root `DESIGN.md` (the design.md contract) |
| `design-tokens.css` | `app/design-tokens.css` (Tailwind v4 `@theme` export) |
| `globals.css` | `app/globals.css` (surfaces, glass, gauges, ground) |
| `BackgroundVideo.tsx` | `components/BackgroundVideo.tsx` (garden video ground) |
| `bg/garden.mp4`, `bg/garden.jpg` | `public/bg/` (Devin's Higgsfield night-garden clip + poster) |

To restore: `git checkout theme-natural-2026-09-22 -- DESIGN.md app/design-tokens.css app/globals.css components/BackgroundVideo.tsx public/bg`.
