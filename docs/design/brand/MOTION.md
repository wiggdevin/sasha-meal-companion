# Motion

Nothing appears or vanishes in a cut. Every morph rides one of four springs (`lib/design/motion.ts`, CSS `linear()` twins in `app/globals.css`). Use them; never add a new duration.

| Spring | Visual duration | Bounce | CSS duration | Use |
| --- | --- | --- | --- | --- |
| `snappy` | 0.30 s | 0.15 | `dur-spring-snappy` 420 ms | Controls: chips, the dock lens, segments, presses |
| `smooth` | 0.45 s | 0 | `dur-spring-smooth` 520 ms | Containers that grow or shrink: cards, trays, sheets |
| `gentle` | 0.55 s | 0.08 | `dur-spring-gentle` 600 ms | Large shape changes: the meal card opening |
| `bouncy` | 0.50 s | 0.28 | `dur-spring-bouncy` 650 ms | Things with weight: Sprout, the orb |

Fades: content arriving `dur-base` (250 ms), leaving `dur-quick` (150 ms), both `cubic-bezier(0.16, 1, 0.3, 1)`. A view that gives way to another in the same place swaps with a 6 px blur and scale 0.98 → 1, never a cut. The morph rule: the frame rides `gentle` both ways and never fades; its content fades in 150 ms after the frame starts to grow and fades out before it shrinks.

Animate `transform` and `opacity`. Allowed exceptions, each named here: container height through `AutoHeight` (springs), SVG `stroke-dashoffset` for ticks and rings, `filter: blur` for the swap, and the 900 ms ring fill. At most three things move at once. Text never moves while someone reads it. Under `prefers-reduced-motion` every helper returns an instant transition.

## Named micro-interactions

| Moment | What moves | Values | Source |
| --- | --- | --- | --- |
| Meal eaten | The tick's stroke draws on, the card dims to 70 % | stroke 320 ms ease-out, 90 ms delay; card `smooth` | Kinetics checkbox draw; transitions.dev success check |
| Swap meal | Old plate blurs out, new plate blurs in; row height follows | swap blur 150 ms out / 250 ms in; height `smooth` | transitions.dev card resize |
| Macro ring fill | Ring dashoffset to the new value | 900 ms ease-out, once per change | Kinetics progress ring |
| Calories left | Digits slide like a reel, fixed widths | `snappy` per digit, 40 ms stagger | motion-primitives Sliding Number |
| Sheet open | Rises from the dock edge, scrim to 40 % | `smooth`; scrim 250 ms | Sasha `Sheet.tsx` |
| Toast and Undo | Toast slides up 12 px with blur 4 → 0; a 6 s drain bar, paused on hover and focus. Undo stays available afterwards in the meal's history and the coach Undo list (7 days) | 250 ms in, 150 ms out | Kinetics undo snackbar |
| Sasha is thinking | After 2 s, one status line ("Finding matches…") with three slow dots | dots 1.2 s loop, stopped under reduced motion | transitions.dev thinking states |
| Coach reply | Appears whole and readable at once; only the bubble fades in | `dur-base` | Sol review: calm over showy |
| Chip choose | Fill slides to the chosen chip | `snappy` | transitions.dev tabs sliding |
| Water tap | The glass fills one cup | `smooth`; the number uses the reel | Sasha water tile |
| Hold to clear | A ring fills while held, releases with no action under 800 ms; a plain "Clear day" button in the menu does the same | 800 ms linear | Kinetics hold to confirm |
| Logo | Bowl rises, S draws up, diamond settles | 800 ms total (`LOGO.md`) | Kimi K3 and Grok specs |

## Lottie

No Lottie in the app shell: the dotLottie web player costs about 0.5 MB on first load (33 KB gzip JS plus a 496 KB gzip wasm). At most one lazy-loaded Lottie, for one empty state, after first paint. The recoloured candidates in the design kit (research folder, outside this repo) are for that one slot and for marketing.

## Don't

- No glow, spotlight, border trails or cursor effects ("nothing glows").
- No confetti. A finished day gets the tick and one calm line.
- No visible bounce on containers. `gentle`'s 0.08 settle is the one allowed overshoot, on the meal card frame; `bouncy` is only for Sprout and the orb.
- No motion longer than 300 ms on something a person waits on to tap.
