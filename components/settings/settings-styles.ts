/* Recipes copied verbatim from the already-themed screens — CARD_TITLE /
   CAPTION / EYEBROW / Card() from EatsReference.tsx, ROW_TITLE and the
   secondary pill from MyFoods.tsx, INK_BUTTON from LogFoodSheet.tsx. No
   mockup exists for this screen; DESIGN.md is the contract. Shared by
   `app/settings/page.tsx` and the cards beside this file (T9 §1).
   Design-system utility className strings, not inline style objects
   (tests/design/inline-style.test.ts) — each still carries its original
   fontSize/fontWeight/letterSpacing/color recipe as the comment above it. */
/** 20px / 400 / -0.01em */
export const CARD_TITLE = "text-subheading font-normal tracking-heading-sm";
/** 14px / 400 / text-muted */
export const CAPTION = "text-caption font-normal text-muted";
/** 16px / 400 / text-primary */
export const ROW_TITLE = "text-body font-normal text-charcoal";
/** A form field's name over its box (one rhythm with components/BodyProfileFields, 2026-10-01).
 *  14px / 500 / text-primary */
export const FIELD_LABEL = "text-caption font-medium text-charcoal";
/** 14px / 400 / text-primary */
export const ROW_VALUE = "text-caption font-normal text-charcoal";
/** 12px / 400 / alert */
export const ALERT = "text-tiny font-normal text-alert";
/** Text inside an `.olive-panel` (a 7 % section tint on the ivory card): ink, never cream
 *  (2026-10-04 contrast fix; DESIGN.md §Contrast). 14px / 400 / line-height 1.6 / text-primary */
export const PANEL_TEXT = "text-caption font-normal leading-relaxed text-charcoal";
/** 12px / 500 / 0.2em / uppercase / text-muted */
export const EYEBROW = "text-overline uppercase text-muted";
/* Buttons are `components/ui/Button` (2026-10-04); the PILL_LABEL and INK_BUTTON recipes are gone. */
