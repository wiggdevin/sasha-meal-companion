"use client";

/**
 * Onboarding v2, lane 5 — the reward beat's card (BRIEF.md §1/§8, VISUAL-SPEC.md §8).
 *
 * Live QA 2026-10-07 (defect 5): this said "Here's your plate for tomorrow", but it is not the
 * plan — Today's planner (`planDay`) picks each meal from all of the person's Eats, so the names
 * here and the first meal on Today differed. It now says only what is true: these are foods the
 * plan is built from, the person's own taps first. No "tomorrow", no "breakfast". When the shell
 * passes `meals` (Today's own `resolveDay` over the same foods, `lib/onboarding/plan-preview.ts`),
 * the card also shows today's first meals by their real labels and times.
 *
 * No numbers in the headline — the macro numbers live behind
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
import KcalText from "@/components/ui/KcalText";
import type { Macros } from "@/lib/types";
import type { PlanPreviewMeal } from "@/lib/onboarding/plan-preview";
import PlanNotes from "@/components/Onboarding/beats/PlanNotes";
import { clock12, type PlanNote } from "@/components/Onboarding/v2/plan-answers";

export type RewardPlateFood = { id: string; name: string; role: "protein" | "carb" | "fat" };

export type RewardPlateTargets = { training: Macros; rest: Macros };

function MacroLine({ title, macros }: { title: string; macros: Macros }) {
  // Polish pass (2026-10-07): DESIGN.md's calorie rule ("Every calorie number carries the shared
  // `.kcal` class") is a hard rule, not a style suggestion — this card's figure was plain text,
  // the one calorie number in onboarding v2 that wasn't persimmon. `KcalText` is the house's own
  // mechanism for it (components/CoachComposedCard.tsx, components/MyFoods.tsx already use it the
  // same way); no new styling invented here.
  return <section className="olive-panel flex flex-col gap-1 p-3">
    <span className="text-tiny font-normal text-muted">{title}</span>
    <strong className="text-heading font-light">
      <KcalText text={`${macros.kcal.toLocaleString()} kcal`} />
    </strong>
    <span className="text-tiny font-normal">
      {macros.protein} g protein · {macros.carbs} g carbs · {macros.fat} g fat
    </span>
  </section>;
}

function MealRow({ meal }: { meal: PlanPreviewMeal }) {
  return <li className="matte-reset flex flex-col gap-0.5 rounded-[16px] bg-fog px-3 py-2.5">
    <span className="text-tiny font-normal text-muted">{meal.label} · {clock12(meal.time)}</span>
    <span className="text-body text-charcoal">{meal.name}</span>
  </li>;
}

export default function RewardPlateCard({ targets, lovedFoods, meals = [], notes = [], onChangeNote,
  showNumbers, onToggleNumbers }: {
  /** `null` while the preview is still being derived (missing a required fact this card cannot
   *  fix) — renders the "preparing" state rather than a crash or a stale number. */
  targets: RewardPlateTargets | null;
  /** The foods the account marked "eats" in the foods beat, one per role when available. */
  lovedFoods: readonly RewardPlateFood[];
  /** Today's first meals, exactly as Today will build them. */
  meals?: readonly PlanPreviewMeal[];
  /** Question set v2 §6: every default the person did not choose, and every route note. */
  notes?: readonly PlanNote[];
  onChangeNote?: (beat: NonNullable<PlanNote["change"]>) => void;
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
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-balance font-display text-heading text-charcoal">Foods you&rsquo;ll see in your plan</h1>
      <p className="m-0 text-caption text-graphite">
        Your meals are built from these. Change them any time in Foods.
      </p>
    </div>
    {meals.length > 0 && <section className="flex flex-col gap-2" aria-label="Your first meals today">
      <h2 className="m-0 text-caption font-medium text-graphite">Your first meals today</h2>
      <ul className="m-0 flex flex-col gap-2 p-0">{meals.map((meal) => <MealRow key={meal.label} meal={meal} />)}</ul>
    </section>}
    {lovedFoods.length > 0 && <ul className="m-0 flex flex-wrap gap-2 p-0" aria-label="Foods in your plan">
      {lovedFoods.map((food) => <li key={food.id}
        className="inline-flex min-h-9 items-center rounded-full bg-fog px-3 text-caption text-charcoal">{food.name}</li>)}
    </ul>}
    <PlanNotes notes={notes} onChange={(beat) => onChangeNote?.(beat)} />
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
