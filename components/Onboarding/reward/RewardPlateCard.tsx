"use client";

/**
 * Onboarding v2, lane 5 — the reward beat's plate card (BRIEF.md §1/§8, VISUAL-SPEC.md §8).
 * "Here's your plate for tomorrow," no numbers in the headline — the macro numbers live behind
 * one tertiary "See the numbers" tap, never inline on the card itself. The plate's own ingredient
 * list is drawn from the foods the account just marked "eats" in the foods beat (one per role
 * when available), not a full composed meal — composing an actual multi-item meal is
 * `compose_meal`/`planDay` territory (Phase 18 W9), outside this card's own scope.
 *
 * The primary "Use this plan" action lives in the shell's own dock (`OnboardingDock`'s "confirm"
 * mode), not inside this card — this card is presentation only, exactly like every other card in
 * `tests/cards/manifest.ts`.
 */
import Button from "@/components/ui/Button";
import type { Macros } from "@/lib/types";

export type RewardPlateFood = { id: string; name: string; role: "protein" | "carb" | "fat" };

export type RewardPlateTargets = { training: Macros; rest: Macros };

function MacroLine({ title, macros }: { title: string; macros: Macros }) {
  return <section className="olive-panel flex flex-col gap-1 p-3">
    <span className="text-tiny font-normal text-muted">{title}</span>
    <strong className="text-heading font-light">{macros.kcal.toLocaleString()} kcal</strong>
    <span className="text-tiny font-normal">
      {macros.protein} g protein · {macros.carbs} g carbs · {macros.fat} g fat
    </span>
  </section>;
}

export default function RewardPlateCard({ targets, lovedFoods, showNumbers, onToggleNumbers }: {
  /** `null` while the preview is still being derived (missing a required fact this card cannot
   *  fix) — renders the "preparing" state rather than a crash or a stale number. */
  targets: RewardPlateTargets | null;
  /** The foods the account marked "eats" in the foods beat, one per role when available. */
  lovedFoods: readonly RewardPlateFood[];
  showNumbers: boolean;
  onToggleNumbers: () => void;
}) {
  if (!targets) {
    // Same `.matte-reset` need as the ready state below — `.well`'s own light `--color-fog`
    // surface would otherwise carry the shell's cream text-role remap straight into invisibility.
    return <div role="status" className="matte-reset well flex flex-col gap-2 p-4"
      data-testid="reward-plate-preparing">
      <p className="m-0 text-body text-charcoal">Putting your plate together…</p>
    </div>;
  }
  // VISUAL-SPEC.md §8/§1: this card is the one light-surface exception inside the otherwise-
  // charcoal onboarding shell — but the shell itself carries `.matte` (DESIGN.md's text-role
  // remap to cream, for everything else on this screen), so this card needs `.matte-reset`
  // (app/globals.css) to map `text-charcoal` back to real ink here. Without it, a cream-on-ivory
  // headline is exactly the "Settings protein-card incident" contrast bug VISUAL-SPEC.md §4
  // warns about — caught live in this lane's own mobile QA run, not by a test.
  return <div className="matte-reset surface flex flex-col gap-4 rounded-[24px] p-5"
    data-testid="reward-plate-ready">
    <h1 className="m-0 font-display text-heading text-charcoal">Here&rsquo;s your plate for tomorrow</h1>
    {lovedFoods.length > 0 && <ul className="m-0 flex flex-wrap gap-2 p-0" aria-label="Tomorrow's foods">
      {lovedFoods.map((food) => <li key={food.id}
        className="rounded-full bg-fog px-3 py-1 text-caption text-charcoal">{food.name}</li>)}
    </ul>}
    <Button size="sm" variant="tertiary" className="self-start" aria-expanded={showNumbers}
      onClick={onToggleNumbers}>
      {showNumbers ? "Hide the numbers" : "See the numbers"}
    </Button>
    {showNumbers && <div className="flex flex-col gap-2" data-testid="reward-plate-numbers">
      <MacroLine title="Training day" macros={targets.training} />
      <MacroLine title="Rest day" macros={targets.rest} />
    </div>}
  </div>;
}
