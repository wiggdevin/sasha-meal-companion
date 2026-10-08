/**
 * Onboarding v2 — the one chip surface every chip and stepper in the conversational shell shares.
 *
 * Live QA 2026-10-07 (defect 1): this used to be `.well`'s light fog fill
 * (`bg-[var(--color-fog)]`) with `text-charcoal`. The shell carries `.matte`, which turns
 * `text-charcoal` cream but leaves `--color-fog` light, so every chip read cream on cream (about
 * 1.1:1). The recipe is now the dock's own chip surface (`dock/OnboardingDock.module.css`
 * `.chipSurface`): a faint tint and a hairline drawn from `--ink-rgb`, which `.matte` remaps to
 * cream and the light ground keeps as ink — so the same chip reads correctly on either scope.
 * `tests/design/contrast-scan.test.ts` rule 6 now fails a light fill under a `.matte` ancestor in
 * another file, which is how this slipped past the scan before.
 *
 * Every caller supplies its own `rounded-*` and its own min-height (≥ 44 px, DESIGN.md).
 */
export const CHIP_FILL = "bg-[rgb(var(--ink-rgb)/0.1)] shadow-[0_0_0_1px_rgb(var(--ink-rgb)/0.3)]";
