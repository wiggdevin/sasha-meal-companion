"use client";
/**
 * Every Today meal card state on static sample data (app/design/meal-cards). No network, no device
 * store: each card is mounted with fixture props alone, so the states can be reviewed and
 * screenshotted at phone width without an account (docs/design/meal-cards-v2.md).
 */
import { useState, type ReactNode } from "react";
import SlotCard from "@/components/SlotCard";
import type { FoodComponent, Macros, ResolvedSlot } from "@/lib/types";

const m = (kcal: number, protein: number, carbs: number, fat: number): Macros => ({ kcal, protein, carbs, fat });
const c = (name: string, qty: number, unit: FoodComponent["unit"], role: FoodComponent["role"], macros: Macros):
  FoodComponent => ({ name, qty, unit, role, macros });

const LUNCH: FoodComponent[] = [
  c("Chicken breast, roasted", 5, "oz", "protein", m(230, 43, 0, 5)),
  c("Brown rice, cooked", 1, "cup", "carb", m(216, 5, 45, 2)),
  c("Broccoli, steamed", 1, "cup", "free", m(55, 4, 11, 1)),
  c("Olive oil", 1, "tsp", "fat", m(40, 0, 0, 5)),
];
const BREAKFAST: FoodComponent[] = [
  c("Greek yogurt, plain", 1, "cup", "protein", m(146, 20, 8, 4)),
  c("Blueberries", 0.5, "cup", "carb", m(42, 1, 11, 0)),
  c("Granola", 0.25, "cup", "carb", m(150, 4, 18, 7)),
];
const DINNER: FoodComponent[] = [
  c("Salmon fillet", 5, "oz", "protein", m(290, 32, 0, 17)),
  c("Sweet potato, baked", 1, "whole", "carb", m(112, 2, 26, 0)),
  c("Green beans", 1, "cup", "free", m(31, 2, 7, 0)),
];
const SNACK: FoodComponent[] = [
  c("Apple", 1, "whole", "carb", m(95, 0, 25, 0)),
  c("Almond butter", 1, "tbsp", "fat", m(98, 3, 3, 9)),
];

const sum = (parts: FoodComponent[]): Macros => parts.reduce((total, part) => m(
  total.kcal + part.macros.kcal, total.protein + part.macros.protein,
  total.carbs + part.macros.carbs, total.fat + part.macros.fat), m(0, 0, 0, 0));

function slot(id: string, label: string, time: string, name: string | null, components: FoodComponent[],
  extra: Partial<ResolvedSlot> = {}): ResolvedSlot {
  return {
    slot: id as ResolvedSlot["slot"], label, time, components, macros: sum(components), eaten: false,
    meal: name === null ? null : {
      id: `gallery-${id}`, name, slot: id as ResolvedSlot["slot"], components, macros: sum(components),
      prepMinutes: 15, tags: [],
    },
    ...extra,
  };
}

const TARGETS = m(1900, 150, 190, 60);
const CONSUMED = m(338, 25, 37, 11);

type Fixture = { title: string; note: string; slot: ResolvedSlot; variant: "focus" | "standard";
  focusLabel?: "Now" | "Next"; emptyReason?: string; planMiss?: string };

const FIXTURES: Fixture[] = [
  { title: "Focus · next meal", note: "The current or next meal, promoted.", variant: "focus", focusLabel: "Next",
    slot: slot("meal-2", "Meal 2", "12:30", "Chicken, brown rice and broccoli", LUNCH) },
  { title: "Focus · now, eaten", note: "Ticked off.", variant: "focus", focusLabel: "Now",
    slot: slot("meal-1", "Meal 1", "08:00", "Greek yogurt, blueberries and granola", BREAKFAST,
      { eaten: true, eatenAt: "08:12" }) },
  { title: "Standard · later meal", note: "A meal that is not the focus.", variant: "standard",
    slot: slot("meal-3", "Meal 3", "18:30", "Salmon, sweet potato and green beans", DINNER) },
  { title: "Standard · eaten", note: "An earlier meal, done.", variant: "standard",
    slot: slot("meal-1", "Meal 1", "08:00", "Greek yogurt, blueberries and granola", BREAKFAST,
      { eaten: true, eatenAt: "08:12" }) },
  { title: "Standard · rule mark", note: "Saved content a current rule blocks.", variant: "standard",
    slot: slot("meal-4", "Meal 4", "15:30", "Apple with almond butter", SNACK, {
      ruleMark: { verdict: "blocked", reason: "Tree nuts are on your allergy list" },
      componentRuleMarks: [null, { verdict: "blocked", reason: "Tree nuts are on your allergy list" }],
    }) },
  { title: "Standard · plan miss", note: "The plate still misses its target.", variant: "standard",
    planMiss: "This plate is 18 g short of protein inside usual portions.",
    slot: slot("meal-5", "Meal 5", "20:30", "Apple with almond butter", SNACK) },
  { title: "Focus · nothing planned", note: "An empty focus slot.", variant: "focus", focusLabel: "Next",
    emptyReason: "Add a breakfast starch or fruit to Favorites.",
    slot: slot("meal-2", "Meal 2", "12:30", null, []) },
  { title: "Standard · nothing planned", note: "An empty later slot.", variant: "standard",
    slot: slot("meal-4", "Meal 4", "15:30", null, []) },
];

function Block({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <section aria-label={title} data-gallery-card={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="m-0 text-heading-sm font-semibold text-charcoal">{title}</h2>
      <p className="m-0 text-tiny text-muted">{note}</p>
    </div>
    {children}
  </section>;
}

function GalleryCard({ fixture }: { fixture: Fixture }) {
  const [shown, setShown] = useState(fixture.slot);
  const noop = () => {};
  return <SlotCard slot={shown} variant={fixture.variant} focusLabel={fixture.focusLabel} canSwap
    onToggleEaten={() => setShown((value) => ({ ...value, eaten: !value.eaten }))}
    onOpenSwap={noop} onTimeChange={noop} onPlanWithCoach={noop} onLogWhatYouAte={noop}
    onAteSomethingElse={noop} onClear={noop} onDelete={noop} foods={{}}
    onSaveComponents={(components) => setShown((value) => ({ ...value, components }))}
    dayTotals={{ consumed: CONSUMED, targets: TARGETS }}
    emptyReason={fixture.emptyReason ?? null} planMiss={fixture.planMiss ?? null} />;
}

export default function MealCardsGallery() {
  return <main className="harvest-ground mx-auto flex min-h-dvh w-full max-w-md flex-col gap-8 px-4 py-6">
    <h1 className="m-0 font-display text-heading text-charcoal">Meal cards</h1>
    {FIXTURES.map((fixture) => <Block key={fixture.title} title={fixture.title} note={fixture.note}>
      <GalleryCard fixture={fixture} />
    </Block>)}
  </main>;
}
