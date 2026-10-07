"use client";

/**
 * Onboarding v2 lane 4: one round food disc — the design lead's webp art
 * (`food-disc-art.ts`, keyed by `Starter.id`) when one exists, a plain short-name circle
 * otherwise. A disc with no art entry renders exactly as it does today, so the art set lands
 * food by food with no code change (coord.md 2026-10-07).
 *
 * The on-screen label is the short name (`food-display-names.ts`); the button's accessible name
 * (`label`, built by the caller from the FULL `dbFood` name) is what assistive tech reads — never
 * the shortened caption.
 *
 * Disc size: 96px (orchestrator 2026-10-07, overriding VISUAL-SPEC.md §6's 72px — noted in
 * FallingFoodPile.tsx's own module doc). With art, the circle is filled edge to edge and the
 * short name sits as a caption below it; with no art yet, the circle falls back to a centered
 * short-name label, same as before the art PR.
 *
 * Layout note: `Button`'s own children sit inside `.btn-label`, which `app/globals.css` sets
 * `display: inline-flex` (a ROW) for the label/confirm/error cross-fade group — a `flex-col`
 * className on the outer `<button>` has no effect on that inner row (GPT-6 Sol r2 WARN, verified
 * against `app/globals.css`). The circle + caption are wrapped in their own inner flex column
 * below so they stack regardless of `.btn-label`'s own direction.
 */
import Button, { type ButtonVariant } from "@/components/ui/Button";
import { foodDiscArtUrl } from "./food-disc-art";

export default function FoodDisc({ id, shortName, label, pressed, variant, size = "md", onToggle }: {
  id: string;
  /** The short on-screen caption ("Chicken"), never the accessible name. */
  shortName: string;
  /** The full accessible name ("Love Chicken breast, roasted"). */
  label: string;
  pressed: boolean;
  variant: ButtonVariant;
  /** `md` (default, 96px): the falling game and its reduced-motion grid.
   *  `sm` (64px): the avoid-round grid, outside the visual spec's scope. */
  size?: "md" | "sm";
  onToggle: () => void;
}) {
  const art = foodDiscArtUrl(id);
  const circlePx = size === "md" ? 96 : 64;
  return <Button aria-label={label} aria-pressed={pressed} variant={variant}
    className="h-auto w-auto flex-col gap-1 rounded-2xl p-1" onClick={onToggle}>
    <span className="flex flex-col items-center gap-1">
      <span className="overflow-hidden rounded-full bg-[rgb(var(--ink-rgb)/0.08)]"
        style={{ width: circlePx, height: circlePx }}>
        {art
          /* eslint-disable-next-line @next/next/no-img-element -- art host isn't fixed yet; no
             next/image remotePatterns entry exists to point at, same as PhotoCapture.tsx's blob URL */
          ? <img src={art} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full items-center justify-center whitespace-normal
              text-center text-tiny leading-tight">
            {shortName}
          </span>}
      </span>
      {/* whitespace-normal overrides .btn's inherited nowrap so a long name can actually wrap;
          line-clamp-2 (not -1, GPT-6 Sol r4 WARN) so that wrapped second line is still shown
          instead of being clipped right after it was unlocked. */}
      {art && <span className="line-clamp-2 whitespace-normal text-tiny leading-tight">{shortName}</span>}
    </span>
  </Button>;
}
