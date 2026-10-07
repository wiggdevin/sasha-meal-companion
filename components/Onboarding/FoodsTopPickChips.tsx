"use client";

/**
 * Onboarding v2 lane 4 (BRIEF §4 "1:10–1:35", Resolved conflict #4): the pilot/open-world
 * equivalent of the legacy falling-food game — no new game surface, same safety-filtered starter
 * list (`choices`, already run through `starterChoices`), rendered as simple top-pick chips.
 * Owner-adopted default (LANES.md): pilot/open-world accounts get this, not the untested game.
 *
 * `choices` carries the same allergy exclusion the legacy game relies on — a confirmed allergy
 * removes the matching chip before this list ever renders, not after.
 */
import { dbFood } from "@/lib/food-db";
import type { Starter, StarterMark } from "@/lib/foods/starter";
import type { FoodRole } from "@/lib/foods";
import Button from "@/components/ui/Button";

const ROLES: readonly FoodRole[] = ["protein", "carb", "fat"];
/** Per role, so a clear profile (all-protein defaults happen to lead the STARTERS table) still
 *  offers something to love across every role, not 12 proteins and nothing else (GPT-6 Sol r1
 *  WARN — ran `topPickChoices` against a clear profile and got zero carbs, zero fats). */
const PER_ROLE_LIMIT = 4;

export function topPickChoices(choices: readonly Starter[]): Starter[] {
  const picks: Starter[] = [];
  for (const role of ROLES) {
    const inRole = choices.filter((item) => item.role === role);
    const defaults = inRole.filter((item) => item.default);
    const rest = inRole.filter((item) => !item.default);
    picks.push(...[...defaults, ...rest].slice(0, PER_ROLE_LIMIT));
  }
  return picks;
}

export default function FoodsTopPickChips({ choices, marks, onMark }: {
  choices: readonly Starter[];
  marks: Record<string, StarterMark>;
  onMark: (id: string, mark: StarterMark) => void;
}) {
  const picks = topPickChoices(choices);
  return <div className="flex flex-col gap-3" data-testid="foods-top-pick-chips">
    <p className="m-0 text-caption text-graphite">Tap the ones you love most.</p>
    <div className="flex flex-wrap gap-2">
      {picks.map((item) => {
        const name = dbFood(item.id)?.name ?? item.id;
        const loved = marks[item.id] === "eats";
        return <Button key={item.id} size="sm" variant={loved ? "primary" : "tertiary"}
          className="rounded-full" aria-label={`Love ${name}`} aria-pressed={loved}
          onClick={() => onMark(item.id, loved ? "neutral" : "eats")}>
          {name}
        </Button>;
      })}
    </div>
  </div>;
}
