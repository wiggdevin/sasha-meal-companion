"use client";

/**
 * Onboarding v2 lane 4 (BRIEF §4, "1:10–1:35"): the legacy starter-food step re-skinned as
 * "tap the ones you love" — ivory discs spring in on `bouncy`, tap toggles a love; a separate,
 * explicit "anything you never eat?" round follows in a red-washed well. `choices` is already the
 * account's safety-filtered starter list (`lib/foods/starter.ts`'s `starterChoices` drops any item
 * whose allergens match a confirmed avoid before this component ever sees it) — a confirmed
 * allergy never reaches this screen as a disc to tap away; it is simply absent (BRIEF §6 lane 4
 * acceptance: "a confirmed allergy visibly removes matching discs/chips before the game/chip
 * screen renders").
 *
 * Reduced motion collapses the falling wave to an instant 3-column grid (rule 11); CSS
 * transforms only (`y`/`opacity`), no new motion dependency.
 *
 * This file is imported, unconditionally and unflagged, by today's live `OnboardingFlow.tsx` step
 * 4 — the form every current account goes through. The whole v2 rebuild ships dark behind
 * `NEXT_PUBLIC_CHAT_ONBOARDING` (GOAL.md, LANES.md) until Lane 5's QA pass, so the re-skin below
 * only renders when that flag is on; otherwise this exports the exact pre-v2 search-and-grid step
 * (`ClassicFoodsGrid`), byte-for-byte the same screen production sees today.
 */
import { useMemo, useState } from "react";
import { dbFood } from "@/lib/food-db";
import { STARTERS, starterFillShortRoles, type Starter, type StarterMark } from "@/lib/foods/starter";
import { ROLE_LABELS, type FoodRole } from "@/lib/foods";
import Button from "@/components/ui/Button";
import SearchField from "@/components/ui/SearchField";
import { foodShortName } from "./food-display-names";
import { useFoodDiscArtReady } from "./food-disc-art";
import FoodDisc from "./FoodDisc";
import FallingFoodPile from "./FallingFoodPile";
import FoodsSafetyGate from "./FoodsSafetyGate";
import type { AllergySafetyAnswer } from "./AllergyConditionGate";

const ROLES: readonly FoodRole[] = ["protein", "carb", "fat"];
const PICK_FOR_ME_PER_ROLE = 2;

type Round = "love" | "avoid";
type FoodsStepProps = {
  choices: readonly Starter[];
  marks: Record<string, StarterMark>;
  onMark: (id: string, mark: StarterMark) => void;
};

/** "Sprout, pick for me": fills ONLY the groups still short of their count, never touching a
 *  food the person already tapped or avoided (live QA 2026-10-07: it used to add the defaults on
 *  top of every tap). The two-per-group fill is `starterFillShortRoles` (lib/foods/starter.ts);
 *  `need` tops a group up further (the legacy plan needs one distinct protein per planned meal),
 *  defaults first. It only fills in marks; nothing is saved here. */
export function pickForMeIds(
  choices: readonly Starter[], marks: Readonly<Record<string, StarterMark>>,
  need: Partial<Record<FoodRole, number>> = {},
): string[] {
  const picked = starterFillShortRoles(choices, marks, PICK_FOR_ME_PER_ROLE);
  for (const role of ROLES) {
    const target = need[role] ?? PICK_FOR_ME_PER_ROLE;
    if (target <= PICK_FOR_ME_PER_ROLE) continue;
    const group = choices.filter((item) => item.role === role);
    const have = group.filter((item) => marks[item.id] === "eats" || picked.includes(item.id)).length;
    const open = group.filter((item) => marks[item.id] !== "eats" && marks[item.id] !== "avoid"
      && !picked.includes(item.id));
    const ordered = [...open.filter((item) => item.default), ...open.filter((item) => !item.default)];
    for (const item of ordered.slice(0, Math.max(0, target - have))) picked.push(item.id);
  }
  return picked;
}

/** The explicit, secondary "anything you never eat?" round — a red-washed, role-sectioned grid
 *  (not a falling pile; the pile choreography is reserved for the primary love round per the
 *  orchestrator's 2026-10-07 direction). Reduced motion needs no special case here: it was never
 *  animated. */
function AvoidRound({ choices, marks, onMark }: FoodsStepProps) {
  useFoodDiscArtReady();
  return <div className="flex flex-col gap-4" data-testid="avoid-round">
    {ROLES.map((role) => {
      const items = choices.filter((item) => item.role === role);
      if (!items.length) return null;
      return <section key={role} aria-label={ROLE_LABELS[role]} className="flex flex-col gap-2">
        <h2 className="m-0 text-caption font-medium text-graphite">{ROLE_LABELS[role]}</h2>
        <div className="well grid grid-cols-3 gap-2 rounded-[16px] bg-red-wash p-2">
          {items.map((item) => {
            const full = dbFood(item.id)?.name ?? item.id;
            const pressed = marks[item.id] === "avoid";
            return <FoodDisc key={item.id} id={item.id} shortName={foodShortName(item.id, full)}
              label={`Never eat ${full}`} pressed={pressed} variant={pressed ? "danger" : "tertiary"}
              size="sm" onToggle={() => onMark(item.id, pressed ? "neutral" : "avoid")} />;
          })}
        </div>
      </section>;
    })}
  </div>;
}

type SafetyState = { confirmed: boolean; answer: AllergySafetyAnswer | null };
const SAFETY_UNCONFIRMED: SafetyState = { confirmed: false, answer: null };

function FallingFoodsStep({ choices, marks, onMark }: FoodsStepProps) {
  const [round, setRound] = useState<Round>("love");
  // The allergy/condition card must render before ANY food UI, every time (BRIEF §6 lane 4
  // acceptance) — including in the live NEXT_PUBLIC_CHAT_ONBOARDING=1 path, not only in this
  // module's own isolated tests (GPT-6 Sol r3/r4 BLOCK: `FoodsSafetyGate` existed but nothing in
  // the flagged branch actually rendered it). `FallingFoodsStep` now owns that gate itself, so
  // every caller of `FoodsStep` gets the ordering guarantee for free.
  const [safety, setSafety] = useState<SafetyState>(SAFETY_UNCONFIRMED);
  const eligibleProteins = useMemo(
    () => choices.filter((item) => item.role === "protein").length, [choices]);

  function pickForMe(): void {
    for (const id of pickForMeIds(choices, marks)) onMark(id, "eats");
  }

  return <FoodsSafetyGate confirmed={safety.confirmed} answer={safety.answer}
    onConfirmNone={() => setSafety({ confirmed: true, answer: "none" })}
    onAddRule={() => setSafety((current) => ({ ...current, answer: "rule" }))}
    onRulesConfirmed={() => setSafety((current) => ({ confirmed: true, answer: current.answer ?? "rule" }))}>
    <div className="flex flex-col gap-4" data-testid="foods-step" data-round={round}>
      <p className="m-0 text-caption text-graphite">
        {round === "love" ? "Tap the ones you love most." : "Anything you never eat?"}
      </p>
      {round === "love"
        ? <FallingFoodPile choices={choices} marks={marks} onMark={onMark} />
        : <AvoidRound choices={choices} marks={marks} onMark={onMark} />}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={pickForMe}>Sprout, pick for me</Button>
        {round === "love"
          ? <Button size="sm" variant="secondary" onClick={() => setRound("avoid")}>
            Next: anything you never eat?
          </Button>
          : <Button size="sm" variant="secondary" onClick={() => setRound("love")}>Back to loves</Button>}
      </div>
      <p className="m-0 text-caption text-graphite">Choose at least two proteins, two carbs and two fats so your meals can vary.</p>
      {eligibleProteins < 2 && <p role="status" className="well m-0 p-4 text-caption text-graphite">
        Your current food rules leave {eligibleProteins} starter {eligibleProteins === 1 ? "protein" : "proteins"}.
        Go Back to Dietary preferences to review your rules, or Skip for now and add safe foods later.
      </p>}
    </div>
  </FoodsSafetyGate>;
}

/** The pre-v2 search-and-grid step, unchanged — what every account sees today while the flag is
 *  off (and the fallback if extraction/transcribe fails even with the flag on, per BRIEF §5). */
function ClassicFoodsGrid({ choices, marks, onMark }: FoodsStepProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const allowed = new Set(choices.map((item) => item.id));
  const eligibleProteins = choices.filter((item) => item.role === "protein").length;
  const visible = query ? choices.filter((item) => dbFood(item.id)?.name.toLowerCase().includes(query))
    : STARTERS.filter((item) => marks[item.id] && marks[item.id] !== "neutral");
  const card = (item: Starter) => {
    const name = dbFood(item.id)?.name ?? item.id;
    const mark = marks[item.id] ?? "neutral";
    return <div key={item.id} className="surface flex items-center gap-2 rounded-[16px] p-2.5">
      <span className="min-w-0 flex-1 text-caption text-charcoal">{name}</span>
      <Button size="sm" aria-label={`I eat ${name}`} aria-pressed={mark === "eats"}
        variant={mark === "eats" ? "primary" : "tertiary"} disabled={!allowed.has(item.id)}
        onClick={() => onMark(item.id, mark === "eats" ? "neutral" : "eats")}>
        Eat
      </Button>
      <Button size="sm" aria-label={`Avoid ${name}`} aria-pressed={mark === "avoid"}
        variant={mark === "avoid" ? "danger" : "tertiary"} data-armed={mark === "avoid" ? "true" : undefined}
        onClick={() => onMark(item.id, mark === "avoid" ? "neutral" : "avoid")}>
        Avoid
      </Button>
    </div>;
  };
  return <div className="flex flex-col gap-4">
    <p className="m-0 text-caption text-graphite">
      These are starting suggestions, not your preferences yet. Choose foods you eat and mark any to avoid.
    </p>
    <label className="flex flex-col gap-1 text-caption text-graphite">
      Find a starter food
      <SearchField value={search} onValueChange={setSearch} label="Find a starter food" placeholder="Search foods" />
    </label>
    {ROLES.map((role) => {
      const items = visible.filter((item) => item.role === role);
      const selected = choices.filter((item) => item.role === role && marks[item.id] === "eats").length;
      return <section key={role} aria-label={ROLE_LABELS[role]} className="flex flex-col gap-2">
        <div className="flex justify-between text-caption text-graphite">
          <h2 className="m-0 font-medium">{ROLE_LABELS[role]}</h2><span>{selected} selected</span>
        </div>
        {items.length ? items.map(card) : <p className="m-0 text-caption text-muted">
          {query ? "No matching starter foods." : "Search to add foods."}
        </p>}
      </section>;
    })}
    <p className="m-0 text-caption text-graphite">Choose at least two proteins, two carbs and two fats so your meals can vary.</p>
    {eligibleProteins < 2 && <p role="status" className="well m-0 p-4 text-caption text-graphite">
      Your current food rules leave {eligibleProteins} starter {eligibleProteins === 1 ? "protein" : "proteins"}.
      Go Back to Dietary preferences to review your rules, or Skip for now and add safe foods later.
    </p>}
  </div>;
}

/** `true` only when the v2 onboarding rebuild is switched on (GOAL.md: "shipped dark" until Lane
 *  5's QA pass flips it). Read once per module, same pattern other flag reads in this tree use. */
const CHAT_ONBOARDING_ON = process.env.NEXT_PUBLIC_CHAT_ONBOARDING === "1";

export default function FoodsStep(props: FoodsStepProps) {
  return CHAT_ONBOARDING_ON ? <FallingFoodsStep {...props} /> : <ClassicFoodsGrid {...props} />;
}

/** Exported for lane 4's own tests and for `FoodsTopPickChips`, which shares the same deck. The
 *  re-skinned step is exported directly too, so a test (or a future L2 shell slot) can render it
 *  without depending on the module-load-time flag read above. */
export { FallingFoodsStep, ClassicFoodsGrid, STARTERS };
