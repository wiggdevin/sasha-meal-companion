"use client";
/**
 * A complete published recipe, laid out to skim (owner ask 2026-10-03: "very easily skimmed, so we
 * know where everything is, colour-coded"): the hero photo and serif title with the serving's calories,
 * the colour-coded facets and diet badges, the nutrition panel (components/nutrition/RecipeNutrition.tsx:
 * per serving, or the day after eating it), the caller's actions, an ingredient checklist with amounts in a right column (Avoid sits in
 * each row's quiet overflow), the method as numbered step cards, and a small muted footer for
 * nutrition notes and provenance. Missing evidence is shown as missing, never guessed.
 */
import Image from "next/image";
import { useId, useState, type ReactNode } from "react";
import { DisclosurePanel } from "@/components/ui/Disclosure";
import Button from "@/components/ui/Button";
import { setFoodMembership } from "@/lib/foods/prefs-client";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { readRecipeChecks, writeRecipeChecks } from "@/lib/recipes/session-checks";
import { RECIPE_MACROS, type RecipeCandidate, type RecipeNutrient } from "@/lib/recipe-catalog/types";
import { macroFacts, recipePhoto } from "@/lib/recipes-hub/hub";
import { displayAmount, displayMinutes } from "@/lib/recipes/preview-display";
import DietBadge from "@/components/nutrition/DietBadge";
import RecipeFacets from "@/components/nutrition/RecipeFacets";
import RecipeNutrition, { ServingKcal } from "@/components/nutrition/RecipeNutrition";
import photoArt from "@/components/ui/MealPhoto.module.css";
import RuleMark from "@/components/ui/RuleMark";
import { useShownRecipeRuleMark } from "@/lib/recipes/recipe-freshness";
import { recipeDietFacts } from "@/lib/recipes-hub/diet";
import { CARD_AMOUNT, CARD_BODY, CARD_META, CARD_SECTION, MEAL_TITLE } from "@/lib/design/meal-type";

function nutrient(label: string, evidence: RecipeNutrient): string {
  if (evidence.status === "unknown" || evidence.value === null) return `${label}: unknown`;
  return `${label}: ${displayAmount(evidence.value)}${evidence.status === "estimated" ? " (estimated)" : ""}`;
}

function SectionTitle({ children, count }: { children: ReactNode; count?: string }) {
  return <div className="flex items-baseline justify-between gap-3">
    <h4 className={`m-0 ${CARD_SECTION}`}>{children}</h4>
    {count && <span className={`${CARD_META} tabular-nums`}>{count}</span>}
  </div>;
}

const MORE = "M5 12h.01M12 12h.01M19 12h.01";
const CHECK = "M5 12.5l4.5 4.5L19 7.5";

/** The ticked ingredients of one recipe revision, kept for the session (like a result card's open
 *  state, components/RecipeResults.tsx), so a card that re-renders or remounts keeps its checklist. */
function useSessionChecks(revisionId: string) {
  const [checked, setChecked] = useState<number[]>(() => readRecipeChecks(revisionId));
  function toggle(seq: number) {
    setChecked((was) => {
      const next = was.includes(seq) ? was.filter((value) => value !== seq) : [...was, seq];
      writeRecipeChecks(revisionId, next);
      return next;
    });
  }
  return { checked, toggle };
}

function Ingredients({ recipe }: { recipe: RecipeCandidate }) {
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const checks = useSessionChecks(recipe.revisionId);
  const [avoiding, setAvoiding] = useState<string | null>(null);
  const [avoidMessage, setAvoidMessage] = useState<string | null>(null);
  const ingredients = [...recipe.ingredients].sort((a, b) => a.seq - b.seq);
  const instance = useId();
  /** The rule is written as the account that tapped; a reply after a switch changes nothing on
   *  screen and tells no listener (audit b4b #7). */
  function avoid(name: string) {
    const account = currentAccountOrNull();
    const same = () => account === null ? currentAccountOrNull() === null : isCurrent(account);
    setAvoiding(name); setAvoidMessage(null);
    void setFoodMembership(name, "avoid", { acknowledge: true, ...(account ? { account } : {}) }).then(() => {
      if (!same()) return;
      setAvoidMessage(`${name} added to your Avoid rules. Search again for updated results.`);
      setOpenSeq(null);
      window.dispatchEvent(new CustomEvent("recipe-avoid-changed", { detail: name }));
    }).catch(() => {
      if (same()) setAvoidMessage(`${name} could not be added to Avoid. Try again.`);
    }).finally(() => setAvoiding(null));
  }
  return <section aria-label="Ingredients" className="flex flex-col gap-1">
    <SectionTitle count={ingredients.length ? `${ingredients.length} items` : undefined}>Ingredients</SectionTitle>
    {ingredients.length ? <ul className="m-0 flex list-none flex-col p-0">{ingredients.map((item) => {
      const open = openSeq === item.seq;
      const id = `${instance}-more-${item.seq}`;
      return <li key={item.seq} data-ingredient={item.name} className="border-b border-hairline last:border-transparent">
        <div className="flex min-h-11 items-center gap-2">
          {/* `relative`: the visually hidden box is placed inside its own row, so focusing it on a tap
              never scrolls anything to a far-off ancestor and back (U5, 2026-10-04, owner: "the only
              thing that should change is the check mark and the cross-out"). */}
          <label className="relative flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input type="checkbox" className="peer sr-only" checked={checks.checked.includes(item.seq)}
              onChange={() => checks.toggle(item.seq)} />
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full border
              border-charcoal/20 text-transparent peer-checked:border-primary peer-checked:bg-primary
              peer-checked:text-on-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary">
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round"><path d={CHECK} /></svg>
            </span>
            <span className="flex min-w-0 flex-col peer-checked:text-muted peer-checked:line-through">
              <span className={CARD_BODY}>{item.name}</span>
              {(!item.required || item.purchaseConversionStatus === "unknown") && <span className="text-tiny text-muted">
                {[item.required ? null : "optional",
                  item.purchaseConversionStatus === "unknown" ? "purchase amount unknown" : null]
                  .filter(Boolean).join(" · ")}</span>}
            </span>
          </label>
          <span className={`shrink-0 text-right ${CARD_AMOUNT}`}>
            {displayAmount(item.quantity, 2)} {item.unit}</span>
          <Button variant="ghost" shape="circle" aria-label={`More for ${item.name}`} aria-expanded={open}
            aria-controls={id} onClick={() => setOpenSeq(open ? null : item.seq)} className="-mr-2 text-muted">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor"
              strokeWidth={2.5} strokeLinecap="round"><path d={MORE} /></svg>
          </Button>
        </div>
        <DisclosurePanel id={id} open={open} keepMounted={false} className="flex flex-wrap items-center gap-2 pb-3 pl-8">
          <Button size="sm" disabled={avoiding !== null} onClick={() => avoid(item.name)}
            status={avoiding === item.name ? "pending" : undefined}>{`Avoid ${item.name}`}</Button>
          <span className="text-tiny text-muted">Adds it to your Avoid rules.</span>
        </DisclosurePanel>
      </li>;
    })}</ul> : <p className="m-0 text-caption text-graphite">Ingredients missing. Find another recipe.</p>}
    {avoidMessage && <p role="status" className="m-0 text-caption text-graphite">{avoidMessage}</p>}
  </section>;
}

function Method({ recipe }: { recipe: RecipeCandidate }) {
  const steps = [...recipe.steps].sort((a, b) => a.seq - b.seq);
  return <section aria-label="Method" className="flex flex-col gap-2">
    <SectionTitle count={steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : undefined}>Method</SectionTitle>
    {steps.length ? <ol role="list" className="m-0 flex list-none flex-col gap-2 p-0">{steps.map((step, index) =>
      <li key={step.seq} data-step-tone={index % 4} className="step-card flex gap-3 rounded-2xl p-3">
        <span aria-hidden="true" className="step-num flex size-7 shrink-0 items-center justify-center rounded-full
          text-tiny font-semibold tabular-nums">{index + 1}</span>
        <span className="sr-only">Step {index + 1}. </span>
        <p className={`m-0 min-w-0 pt-0.5 ${CARD_BODY}`}>{step.text}</p>
      </li>)}</ol> : <p className="m-0 text-caption text-graphite">Method missing. Find another recipe.</p>}
  </section>;
}

function Footer({ recipe }: { recipe: RecipeCandidate }) {
  const entries = Object.entries(recipe.nutritionPerServing);
  const macros = new Set<string>(RECIPE_MACROS);
  const others = entries.filter(([key]) => !macros.has(key));
  const missing = entries.some(([, value]) => value.status === "unknown" || value.value === null);
  const estimated = entries.some(([, value]) => value.status === "estimated");
  const extra = [recipe.activeMinutes === null ? "Active time not recorded" : `${displayMinutes(recipe.activeMinutes)} active`,
    recipe.yieldGrams === null ? "Yield not measured"
      : `Yield ${recipe.yieldGrams} g${recipe.yieldStatus === "estimated" ? " estimated" : ""}`];
  return <footer aria-label="About this recipe" className="flex flex-col gap-1 border-t border-hairline pt-3 text-tiny text-muted">
    {entries.length === 0 ? <p className="m-0">Nutrition incomplete. Exact fit is unavailable.</p>
      : missing ? <p className="m-0">Some nutrition values are missing. A reliable portion preview is unavailable.</p>
        : estimated ? <p className="m-0">Nutrition is estimated. A portion preview may be approximate. Exact fit is unavailable.</p>
          : null}
    {others.length > 0 && <p className="m-0">Also per serving: {others.map(([key, value]) =>
      nutrient(key.replaceAll("_", " "), value)).join(" · ")}</p>}
    <p className="m-0">{extra.join(" · ")}</p>
    <p className="m-0">By {recipe.source.author}. {recipe.source.kitchenTested ? "Kitchen tested." : "Kitchen test not recorded."}</p>
    {recipe.source.sourceUrl && <a className="tap inline-flex min-h-11 items-center self-start text-caption text-graphite underline"
      href={recipe.source.sourceUrl} target="_blank" rel="noopener noreferrer">View source</a>}
  </footer>;
}

/**
 * `titled` draws the hero photo and serif title; a card whose own header already shows them (the
 * catalog result card) passes false. `actions` sit right under the macro strip, within reach.
 */
export default function RecipeDetails({ recipe, titled = true, actions, date, showRuleMark = true }: {
  recipe: RecipeCandidate; titled?: boolean; actions?: ReactNode;
  /** The day the meal would be eaten on, for the macro strip's "your day after this"; today if unset. */
  date?: string;
  /** False when the card above already states the mark's reason (its eligibility alert). */
  showRuleMark?: boolean;
}) {
  const ruleMark = useShownRecipeRuleMark(recipe);
  const sourceOnly = recipe.source.rightsKind === "link_only";
  const facts = macroFacts(recipe);
  const serving = { kcal: facts.kcal.value, protein: facts.protein.value, carbs: facts.carbs.value, fat: facts.fat.value };
  const estimated = { kcal: facts.kcal.estimated, protein: facts.protein.estimated, carbs: facts.carbs.estimated, fat: facts.fat.estimated };
  const diet = recipeDietFacts(recipe);
  const photoSrc = recipePhoto(recipe);
  return <div data-recipe-details className="flex min-w-0 flex-col gap-4">
    <header className="flex flex-col gap-3">
      {titled && <>
        {photoSrc ? <Image src={photoSrc} alt="" width={736} height={352} sizes="400px"
          className="h-44 w-full rounded-2xl object-cover" />
          : <span aria-hidden="true" className={`block h-44 w-full rounded-2xl ${photoArt.clip}`} />}
        <div className="flex items-start justify-between gap-3">
          <h3 className={`m-0 ${MEAL_TITLE.hero}`}>{recipe.name}</h3>
          <ServingKcal kcal={serving.kcal} />
        </div>
      </>}
      <RecipeFacets cuisine={recipe.cuisine} minutes={recipe.totalMinutes} servings={recipe.servings} variant="line" />
      {/* Under the current rules (the planning routes' `ruleMark`); never hides the recipe. */}
      {showRuleMark && <RuleMark mark={ruleMark} />}
    </header>
    <RecipeNutrition serving={serving} estimated={estimated} date={date} badges={diet.length > 0 ? <ul aria-label="Diet"
      className="m-0 flex list-none flex-wrap gap-1.5 p-0">{diet.map((fact) => <li key={fact}><DietBadge fact={fact} /></li>)}</ul>
      : undefined} />
    {actions}
    {sourceOnly ? <p className="m-0 text-caption text-graphite">This source permits a link only. Open it for the full recipe.</p> : <>
      <Ingredients recipe={recipe} />
      <Method recipe={recipe} />
    </>}
    <Footer recipe={recipe} />
  </div>;
}
