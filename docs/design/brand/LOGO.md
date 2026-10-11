# Logo

## The mark: Steam

An olive half-disc bowl, a geometric monoline **S** rising above it as steam, and a small `persimmon` diamond at the S's upper right. The bowl is the meal, the S is Sasha, the diamond is the ◆ ornament from the meal card, here as seasoning.

Construction on a 512 grid (rebuild from these numbers, never by eye):

| Part | Geometry |
| --- | --- |
| Bowl | Half-disc, flat rim at y 316, x 84 → 428, radius 172, centre (256, 316) |
| S | Two stacked circular arcs sharing a horizontal tangent: top r 72 at (260, 176), bottom r 80 at (260, 328); stroke 78; butt ends cut on the 45° diagonal; scaled 0.56 about (260, 240) and centred at (256, 186) |
| Gap | 18 units between the lowest point of the S and the rim |
| Diamond | Square of half-diagonal 22, rotated 45°, centred (350, 106) |

## The system

| Piece | Use | File |
| --- | --- | --- |
| Primary mark | Website, splash, print | `public/brand/steam-mark.svg` (olive + persimmon) |
| One-ink mark | Single-colour print, stamps, embossing | `steam-mark-mono.svg` |
| App icon, olive | iOS, Android, PWA (`any` and `maskable`) | `public/brand/app-icon-olive.svg`; PNGs `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png` |
| App icon, charcoal | Alternate icon, dark marketing | `app-icon-charcoal.svg` |
| Assistant avatar | Sasha in the coach chat (circle) | `avatar.svg` |
| Horizontal lockup | Website header, documents | `lockup-horizontal.svg` |
| Stacked lockup | Splash, store art | `lockup-stacked.svg` |
| Favicon | 16 and 32 px | `favicon.svg` |

**Wordmark.** "Sasha" in Fraunces, title case, as a person's name: `font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 1`, weight 520, tracking −0.02em, `ink` on light grounds and `cream` on olive or charcoal. Never Plus Jakarta Sans, never italic, never all caps, never letter-spaced.

**Lockup.** Horizontal: mark height = 1.4 × the wordmark's cap height, gap = 0.45 × cap height, mark centred on the cap height. Stacked: mark, gap 0.3 × cap height, wordmark, centred. The app icon never contains the word; the phone prints "Sasha" under it.

**Clear space.** The S's stroke width (as drawn at that size) on every side, at least.

**Minimum sizes.** Mark with diamond 24 px. App icon artwork fills about 62 % of the canvas, so it survives the Android maskable circle. Below 20 px use the favicon: bowl and S only, no diamond. Horizontal lockup 112 px wide; wordmark alone 72 px wide.

## Colour

| Ground | Bowl and S | Diamond | Word |
| --- | --- | --- | --- |
| `oat`, `ivory` | `olive` | `persimmon` | `ink` |
| `olive` | `cream` | `persimmon` | `cream` |
| `charcoal` | `cream` | `persimmon` | `cream` |
| One ink | `olive`, `charcoal` or `cream` | same ink | same ink |

Macro hues other than `persimmon` are UI colours, never logo colours. On a photograph, put the mark on a solid `olive` or `ivory` plate first.

## Motion: the logo animation (800 ms, cold start only)

| Time | Part | Motion | Easing |
| --- | --- | --- | --- |
| 0–260 ms | Bowl | Rises 10 px into place, opacity 0 → 1 | `cubic-bezier(0.16, 1, 0.3, 1)` |
| 160–620 ms | S | Draws upward (stroke-dashoffset to 0), like steam leaving the bowl | `cubic-bezier(0.65, 0, 0.35, 1)` |
| 600–800 ms | Diamond | Scale 0 → 1 with a small settle, the full stop of the sentence | the `snappy` spring |

No glow, no bounce on the bowl, no idle loop inside the app. Reduced motion: the mark is simply there.

## Misuse

- Do not redraw, stretch, rotate or outline the mark.
- Do not change the diamond's colour, move it, or add more diamonds.
- Do not put the S inside a circle as the app icon (it reads as a coin or a finance app).
- Do not add steam lines, leaves, forks, hearts or a pulse line.
- Do not set the wordmark in the UI sans, in caps, or with a stroke.
- Do not place the mark straight on food photography.
- Do not use Sprout (the pet) as the logo. Sprout is a character, the bowl is the brand.

## How it was chosen

Grok proposed five directions (Linen, Wonk, Hearth, Cover, Setting); Kimi K3 critiqued the shortlist and proposed two more (Two Seats, Setting). Rendered side by side, Linen read as a road sign and Hearth as a Wi-Fi or location pin, and an S alone inside a disc read as a coin. Steam won for the app icon, the lockup and the avatar, and still reads at 32 px. Kimi's risk note (a floating S can read as a tilde) is answered by the short, fixed gap and the heavy stroke.
