"use client";

/**
 * Development gallery for onboarding v2 (`/design/onboarding`): the REAL `ConversationalOnboarding`
 * shell, driven with local sample data so every beat can be seen and screenshotted at phone width
 * without an account and without writing anything. The foods and reward beats use the shell's own
 * slots with the real `FallingFoodPile` and `RewardPlateCard`; `?saving=1` shows the saving state.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import ConversationalOnboarding from "@/components/Onboarding/ConversationalOnboarding";
import FallingFoodPile from "@/components/Onboarding/FallingFoodPile";
import RewardPlateCard from "@/components/Onboarding/reward/RewardPlateCard";
import SavingStage from "@/components/Onboarding/SavingStage";
import { dbFood } from "@/lib/food-db";
import { foodShortName } from "@/components/Onboarding/food-display-names";
import { STARTERS, starterFillShortRoles, type StarterMark } from "@/lib/foods/starter";
import styles from "./ConversationalOnboarding.module.css";

const DECK = STARTERS.filter((item) => item.diets.includes("omnivore"));
const SAMPLE_TARGETS = {
  training: { kcal: 2150, protein: 150, carbs: 220, fat: 70 },
  rest: { kcal: 1850, protein: 150, carbs: 160, fat: 65 },
};
const SAMPLE_MEALS = [
  { label: "Meal 1", time: "08:00", name: "Greek yogurt with oats and berries", kcal: 520, proteinG: 38, components: [] },
  { label: "Meal 2", time: "12:30", name: "Chicken with rice and broccoli", kcal: 640, proteinG: 48, components: [] },
];

export default function OnboardingGallery() {
  const params = useSearchParams();
  const [marks, setMarks] = useState<Record<string, StarterMark>>({});
  const [shown, setShown] = useState<readonly string[]>(params.get("shown") === "all" ? DECK.map((item) => item.id) : []);
  const [showNumbers, setShowNumbers] = useState(false);
  const mark = (id: string, value: StarterMark) => setMarks((current) => ({ ...current, [id]: value }));
  const loved = DECK.filter((item) => marks[item.id] === "eats" || starterFillShortRoles(DECK, marks).includes(item.id))
    .map((item) => ({ id: item.id, name: foodShortName(item.id, dbFood(item.id)?.name ?? item.id), role: item.role as "protein" | "carb" | "fat" }));

  if (params.get("saving") === "1") {
    return <div className={`${styles.shell} matte`}>
      <SavingStage title="Building your plan…" step="Saving your profile, targets and foods." />
    </div>;
  }
  return <ConversationalOnboarding onSkip={() => {}} onComplete={() => {}} slots={{
    foodGame: <FallingFoodPile choices={DECK} marks={marks} onMark={mark} shownIds={shown}
      onShown={(id) => setShown((current) => current.includes(id) ? current : [...current, id])} />,
    plateReward: <RewardPlateCard targets={SAMPLE_TARGETS} lovedFoods={loved.slice(0, 6)} meals={SAMPLE_MEALS}
      showNumbers={showNumbers} onToggleNumbers={() => setShowNumbers((value) => !value)} />,
  }} />;
}
