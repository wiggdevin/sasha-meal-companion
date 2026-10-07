---
version: "alpha"
name: "Sasha Meal Companion"
description: "Phone-first nutrition PWA for one person. Light NeuForm glass material on a natural palette: linen ground with a faint morning-light wash, gradient hairline shells, moss and sage surfaces, gauges in clay, heather, moss and honey. Client-owned identity; never reuse elsewhere."
colors:
  primary: "#5A6847"
  secondary: "#F1ECDF"
  tertiary: "#C96F4A"
  neutral: "#F6F4EE"
  background: "#F6F4EE"
  surface: "#FFFFFF"
  text-primary: "#2A2B25"
  text-secondary: "#4A4C42"
  text-muted: "#6D705F"
  text-faint: "#7B7E6F"
  border: "#FFFFFF"
  accent: "#5A6847"
  olive-deep: "#3D4633"
  olive-shell-top: "#A9BD8F"
  olive-shell-bottom: "#2F3A2A"
  charcoal: "#3F463A"
  charcoal-deep: "#2B2F28"
  ink-button-top: "#5A6847"
  ink-button-bottom: "#3D4633"
  gauge-calories: "#C96F4A"
  gauge-calories-end: "#E39A6B"
  gauge-protein: "#8B7BB8"
  gauge-protein-end: "#B9ABDC"
  gauge-carbs: "#6F7F57"
  gauge-carbs-end: "#A9BD8F"
  gauge-fat: "#C9A24A"
  gauge-fat-end: "#E6C77B"
  gauge-water: "#7FA8BF"
  gauge-water-end: "#B5D0DE"
  on-olive: "#F1ECDF"
  on-olive-muted: "#C5C9B6"
  on-charcoal: "#EFE9DC"
  on-charcoal-muted: "#B9BCAE"
typography:
  display-lg:
    fontFamily: "System Font"
    fontSize: "64px"
    fontWeight: 300
    lineHeight: "64px"
    letterSpacing: "-0.03em"
  display-md:
    fontFamily: "System Font"
    fontSize: "40px"
    fontWeight: 300
    lineHeight: "40px"
    letterSpacing: "-0.025em"
  heading-sm:
    fontFamily: "System Font"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  body-md:
    fontFamily: "System Font"
    fontSize: "14px"
    fontWeight: 300
    lineHeight: "20px"
  body-sm:
    fontFamily: "System Font"
    fontSize: "12px"
    fontWeight: 300
    lineHeight: "19.5px"
  label-md:
    fontFamily: "System Font"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  eyebrow:
    fontFamily: "System Font"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0.1em"
    textTransform: "uppercase"
  eyebrow-sm:
    fontFamily: "System Font"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "14px"
    letterSpacing: "0.2em"
    textTransform: "uppercase"
rounded:
  sm: "12px"
  md: "16px"
  lg: "28px"
  xl: "32px"
  full: "9999px"
spacing:
  base: "4px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  gap: "12px"
  card-padding: "20px"
  section-padding: "16px"
components:
  button-primary:
    textColor: "#FFFFFF"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
  button-olive:
    textColor: "{colors.on-olive}"
    typography: "{typography.eyebrow-sm}"
    rounded: "{rounded.full}"
    padding: "0 6px 0 18px"
  card:
    rounded: "{rounded.xl}"
    padding: "20px"
  pill:
    rounded: "{rounded.full}"
    padding: "8px 14px"
---

## Overview

Sasha's Meal Companion is a light, glassy, phone-first interface. Every surface reads as one material:
a linen ground under a faint morning-light wash, cards wrapped in a one-pixel gradient hairline shell
with an inset highlight, and a small family of dark surfaces — moss for emphasis panels, bark for the
eaten meal card — that carry linen text. Colour comes from a kitchen garden, not a screen: every
gradient is two neighbouring natural tones, never a hue jump. Nothing here belongs to any other project.

- **Composition cues:** Layout: single column, phone-first · Content width: 390 px with 16 px gutters ·
  Framing: glassy cards on an open ground · Grid: 4 px rhythm.

## Colors

The palette is light and natural (2026-09-18, replacing the olive/beige/charcoal set): `#F6F4EE` linen
ground, white-to-`#fafafa` card surfaces, `#2A2B25` / `#4A4C42` text. Moss `#5A6847` (deep `#3D4633`,
shells `#6F7F57 → #5A6847 → #2F3A2A`, sage `#A9BD8F` at the light end) is the emphasis surface; linen
`#F1ECDF` is its text. Bark `#3F463A → #2B2F28` is the eaten meal card. The primary button is the moss
gradient `#5A6847 → #3D4633` with white text. Clay `#C96F4A → #A9532F` is reserved for the FAB: the one
warm surface on a screen, so it is found without looking.

Behind every screen sits the garden: a fixed, silent 12 s clip of a night garden in flower
(`public/bg/garden.mp4`, 720p, 0.8 MB, Devin's own Higgsfield render) in true colour: no scrim, no
filter. Text that sits on the bare ground — screen titles, the Foods section headings and counts — is
linen `#EFE9DC` (muted `#B9BCAE`) with a dark halo (`.ground`, `.ground-muted`); everything else sits on
frosted glass. A blurred still of the same frame (`public/bg/garden.jpg`) is the poster, the
reduced-motion ground and the data-saver ground. The cards are frosted glass over it (see Elevation).

Gauges, fixed per macro and never reassigned: **calories** clay `#C96F4A → #E39A6B`, **protein** heather purple
`#8B7BB8 → #B9ABDC`, **carbs** moss `#6F7F57 → #A9BD8F`, **fat** honey `#C9A24A → #E6C77B`.
No brown anywhere (retired 2026-09-10); clay is the warm accent, never a surface.

Text on white: `#2A2B25` primary, `#4A4C42` secondary, `#6D705F` muted (≥ 4.5:1 at 12 px), `#7B7E6F`
faint (large or non-essential text only). Text on moss/bark: `#F1ECDF` / `#EFE9DC`, muted
`#C5C9B6` / `#B9BCAE`.

## Typography

System font only (`system-ui, -apple-system, "SF Pro Text", sans-serif`). Display sizes are weight 300
with tight tracking (64 px gauge numeral, 40 px screen titles). Body is 300; labels 400; eyebrows are 500,
uppercase, tracked 0.1–0.2 em. Numerals in gauges and totals use `font-variant-numeric: tabular-nums`.
No serif, no webfont.

## Layout

One column at 390 px with 16 px gutters and a 4 px base rhythm; card gaps 12 px, section gaps 20 px.
Screens scroll; the tab bar floats over the bottom 92 px. Every tap target is at least 44 × 44 px.

## Elevation & Depth

Glass first. Cards are a **gradient hairline shell** (1 px padding, `linear-gradient(180deg, #fff, rgba(255,255,255,.8), rgba(0,0,0,.1))`,
32 px radius) around a surface (`linear-gradient(180deg, #fff, #fafafa)`, 31 px radius, `inset 0 2px 4px #fff, inset 0 -2px 4px rgba(0,0,0,.02)`).
Shell shadow stack: `0 0 0 1px rgba(0,0,0,.06), 0 1px 1px -.5px rgba(0,0,0,.06), 0 3px 3px -1.5px rgba(0,0,0,.06), 0 6px 6px -3px rgba(0,0,0,.06), 0 12px 12px -6px rgba(0,0,0,.06), 0 24px 24px -12px rgba(0,0,0,.06)`.
Dark panels use `inset 0 1px 1px rgba(255,255,255,.1), inset 0 -1px 1px rgba(0,0,0,.2)`. Blur 12 px on
floating chrome (tab bar, sheets). Inputs are inset wells: `inset 0 2px 4px rgba(0,0,0,.03), 0 0 0 1px rgba(0,0,0,.06)`, 16 px radius.

### Techniques
- **Glass (2026-09-18):** every card surface is frosted, not painted — white at 66–74 % with
  `backdrop-filter: blur(22px) saturate(150%)`, so the garden shows through softly; the pill, the well and the
  tab bar follow at 60–72 %; the moss and bark panels sit at 84–88 % with an 18 px blur. Sheets stay opaque:
  a form is read, not looked through.
- **Gradient hairline shell:** wrap the surface in a 1 px-padded gradient div; the surface radius is the
  shell radius minus 1 px. The gradient is the edge; there is no solid stroke.
- **Pill:** the same shell at 9999 px with a white-to-`#fcfcfc` interior and a 1 px white inset highlight.
- **Gauge:** the arc alone (2026-09-18: the tick ring and the dashed guide are gone). A track at 5 % black, a
  gradient arc with round caps (6 px hero, 4 px mini), a soft `drop-shadow(0 0 6px)` glow at 25 %, and a
  tracer dot at the arc end. Numerals sit in the centre with an eyebrow beneath.
- **Progress card:** five dials, balanced. Calories in the centre (160 viewBox), protein over fat on the
  left, carbs over water on the right (64 viewBox each). Water is sky `#7FA8BF → #B5D0DE`, never a macro
  colour. The water dial is pressable (2026-09-18): a tap adds one cup; a 450 ms hold opens a pill slider
  above it and the finger drags left or right, one cup per 28 px, release saves. A logged snack card takes
  the same hold as a plan card: the timeline opens and release saves the time she actually ate it.
- **Meal card:** charcoal body in an olive shell, 28–32 px radius; photo with an 80 px top-right curve;
  olive macro panel (Protein / Carbs / Fat / Fibre); beige bottom bar with the kcal numeral, a status
  eyebrow, a serving stepper and an olive "Log it" pill with an icon circle.

## Shapes

Radii: 12 px buttons and inset wells (16 px), 28 px meal cards, 32 px cards, 9999 px pills and gauges.
Corner brackets on the gauge card at 14 % black, 10 px. Icons are linear, 1.5–1.75 px stroke, 16–24 px,
Solar-style, drawn as inline SVG; never emoji.

## Components

### Buttons
- **Primary (ink):** `#2A2A2A → #111111`, white text 14 px/400, 12 px radius, 44–52 px tall,
  `1px solid rgba(0,0,0,.2)`, `inset 0 1px 1px rgba(255,255,255,.15)`.
- **Olive pill (meal card / Foods):** `#4F5343`, beige eyebrow-sm text, icon circle with 20 % white border.
- **Icon tile:** 20–24 px, 6 px radius, gold `#FBC336 → #E5A50A` or ink gradient, white glyph.

### Cards and Surfaces
- **Glass card:** shell + surface as above, 20 px padding.
- **Olive panel:** `#4F5343 → #3A3D31`, beige text, 24–31 px radius (note card on Today, macro panel).
- **Charcoal meal card:** as described under Techniques.
- **Tab bar:** pill shell, 92 % white glass with 12 px blur, five items — Today, Week, Body, Foods,
  Settings — with Coach as a sixth once it ships, active in `#111111` weight 400. Body shows only
  when body data is on. The grid follows the rendered item count so every item keeps a 44 px target;
  below 360 px the label drops to glyph-only (the icon keeps its accessible name).

### Iconography
- Linear, one stroke width per screen, currentColor. Status icons: check in a filled olive circle.

## Do's and Don'ts

### Do
- Do keep every surface on the glass recipe; add depth with the shell and insets, not new shadows.
- Do keep the four gauge colours fixed per macro.
- Do keep the 4 px rhythm and the 44 px minimum target.
- Do write copy in Sasha's coach's voice: short, plain, no exclamation marks.

### Don't
- Don't reintroduce brown, the old dark flame ground, or any palette from another client.
- Don't add a serif or a webfont.
- Don't use emoji as icons, left-border accent stripes, or any page ground other than the garden clip and
  its poster.
- Don't exceed the motion level below.

## Motion

Calm, and alive where something changed. 150 ms on press: every button and tappable link settles 2 %
smaller while held, no bounce. 500–800 ms `cubic-bezier(0.2, 0.8, 0.2, 1)` for card entrance
(translateY 16 px, scale 0.98, blur 4 px → none, 120 ms stagger); coach bubbles rise 8 px over 350 ms.
Gauge arcs draw over 1.2 s ease-out on first paint while the numeral counts up from 0; when a meal is
logged or unticked the arc grows to the new value and the numeral counts from its last value over
0.6 s. The tab bar's moss pill slides to the tapped tab over 350 ms. The background wash drifts 3 %
over a minute. Respect `prefers-reduced-motion`: numbers and arcs just change, the garden is a still and
the pill stands still.

**Motion Level:** moderate
**Durations:** 150ms, 350ms, 600ms, 800ms, 1200ms
**Easings:** ease, cubic-bezier(0.2, 0.8, 0.2, 1)
**Hover Patterns:** transform, color

## Today interaction update — 2026-09-15

The day strip shares one glass shell with nutrition progress. Selected days stay centered with a small red underline (the existing alert color), native horizontal snapping and automatic selection. The month/date picker appears on interaction; persistent month arrows are removed. Fast swipes advance one week. Supported browsers pulse at selection detents; unsupported devices retain visual feedback.

Uneaten meals use light glass. Eaten meals use charcoal with a light strikethrough. Tap edits; swipe right swaps. Long hold opens a dimmed full-day timeline with 15-minute steps and a smaller floating meal preview. Edge scrolling reaches every time; release saves and the usual stack sorts chronologically. Quick meals (formerly Floor Day) lives in Day type, retaining the authored backup meals. Navigation contains Today, optional Body, Foods, Settings; Coach opens from the FAB.
