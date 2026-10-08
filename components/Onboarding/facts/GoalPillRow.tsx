"use client";

/**
 * Onboarding v2, lane 3 — the goal-first 4-pill card (BRIEF.md §2/§4): the opener, "What would
 * feel different in eight weeks?", with four human-worded pills, jargon-free (critique of B,
 * point 7). No safe default exists for this field (Phase 10 §2) — nothing here is pre-selected,
 * and a tap is the only way this resolves; it is never inferred from speech tone.
 *
 * The app's own name is never spelled literally in a component (tests/tenancy/
 * no-personal-defaults.test.ts's PERSON_NAME rule) — `APP_NAME` is the one allowlisted spelling.
 */
import { APP_NAME } from "@/lib/brand";
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";
import type { Goal } from "@/components/Onboarding/facts/types";

const PILLS: { value: Goal; label: string }[] = [
  // Question set v2 (V8): the reviewed wording.
  { value: "lose_fat", label: "Lose weight" },
  { value: "gain_muscle", label: "Build muscle" },
  { value: "recomp", label: "Lose fat and build muscle" },
  { value: "maintain", label: "Keep my weight" },
];

export function GoalPillRow({
  value,
  onSelect,
  question,
}: {
  value?: Goal;
  onSelect: (value: Goal) => void;
  /** Replaces the opener's greeting when the goal is asked later in the facts beat. */
  question?: string;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <p className="m-0 font-serif text-heading-sm text-charcoal">
        {question ?? <>Hey. I&rsquo;m {APP_NAME}. What&rsquo;s your main goal right now?</>}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Goal">
        {PILLS.map((pill) => (
          <button
            key={pill.value}
            type="button"
            onClick={() => onSelect(pill.value)}
            aria-pressed={value === pill.value}
            className={`${CHIP_FILL} min-h-12 rounded-full px-5 text-body font-medium text-charcoal data-[pressed=true]:text-on-primary data-[pressed=true]:[background:var(--grad-ink)]`}
            data-pressed={value === pill.value}
          >
            {pill.label}
          </button>
        ))}
      </div>
    </div>
  );
}
