/**
 * Onboarding v2, lane 3 — the recessed-fill look every chip in this folder shares, written out in
 * raw tokens instead of the shared `.well` class (tests/design/buttons.test.ts's ratchet: a `well`
 * class on a `<button>` tag is the legacy recipe `components/ui/Button` replaced, and is barred
 * from growing outside the files already grandfathered onto its allowlist). This reproduces
 * `.well`'s own rule (app/globals.css) — `box-shadow: 0 0 0 1px rgb(var(--ink-rgb) / 0.06);
 * background: var(--color-fog);` — as Tailwind arbitrary-value utilities, so nothing here is a
 * `well`-class button and nothing here is an inline `style` object either (which would otherwise
 * need its own entry in tests/design/inline-style.test.ts's ALLOWED list for a property that
 * guard doesn't even cover). Every caller still supplies its own `rounded-*` utility (every chip
 * here is `rounded-full`, not `.well`'s own 16px) — this constant stays out of that property so
 * two radius classes on one element never fight the cascade.
 */
export const CHIP_FILL = "bg-[var(--color-fog)] shadow-[0_0_0_1px_rgb(var(--ink-rgb)/0.06)]";
