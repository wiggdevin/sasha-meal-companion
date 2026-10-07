"use client";

import Link from "next/link";
import { useState } from "react";
import Button from "@/components/ui/Button";
import DateField from "@/components/ui/DateField";
import GlassSelect from "@/components/ui/GlassSelect";
import KcalText from "@/components/ui/KcalText";
import Thinking from "@/components/ui/Thinking";
import { RECIPE_MACROS, type RecipeCandidate } from "@/lib/recipe-catalog/types";
import { acceptRecipePlan, previewRecipePlan } from "@/lib/recipe-plan-client";
import { rulesUncheckedMark } from "@/lib/recipes/rule-mark-wire";
import RuleMark from "@/components/ui/RuleMark";
import { ruleMarkReason } from "@/lib/rule-mark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";
import { judgedRulesKey, phoneRulesKey, RECIPE_RECHECK_MARK, recipeRuleInputs, useRecipeReader,
  useRecipeRuleInputs, verdictNow } from "@/lib/recipes/recipe-freshness";
import type { RecipePreviewResult } from "@/lib/shopping/preview-contract";
import { displayAmount, distinctEvidenceIssues, evidenceSummary } from "@/lib/recipes/preview-display";
import Disclosure from "@/components/ui/Disclosure";
import Notice from "@/components/ui/Notice";

function today(): string {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export default function RecipePlanFlow({ recipe, onClose, initialDate, initialSlotId, onPlanned }: {
  recipe: RecipeCandidate; onClose: () => void; initialDate?: string; initialSlotId?: string;
  onPlanned?: () => void;
}) {
  const [date, setDate] = useState(initialDate ?? today);
  const [slotId, setSlotId] = useState(initialSlotId ?? "meal-1");
  const [fraction, setFraction] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<RecipePreviewResult | null>(null);
  /** The rule inputs the shown preview, and the saved plan, were read under. */
  const [previewInputs, setPreviewInputs] = useState<string | undefined>(undefined);
  const [savedInputs, setSavedInputs] = useState<string | undefined>(undefined);
  const inputsNow = useRecipeRuleInputs();
  // The preview's reader (lib/recipes/recipe-freshness.ts): one generation, the one before aborted,
  // and while the panel is open a rule change runs the same preview again ("Checking…" meanwhile).
  const { reader, stale: previewStale } = useRecipeReader<RecipePreviewResult>({
    apply: (result, inputs) => {
      setFraction(result.servingFraction); setPreview(result); setPreviewInputs(inputs); setRequestId(null);
    },
    judged: (result) => judgedRulesKey(result) === phoneRulesKey(),
  });
  const [requestId, setRequestId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The plan's verdict under the current rules, as the accept answered it; never blocks the add. */
  const [savedMark, setSavedMark] = useState<RuleMarkValue | null>(null);
  /** The preview's 422: the rules could not be read, so nothing could be sized or stored. */
  const [unchecked, setUnchecked] = useState<RuleMarkValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A changed date, meal or amount: the shown preview is gone, and nothing re-runs it. */
  const dropPreview = () => { reader.clear(); setPreview(null); };
  async function prepare() {
    setBusy(true); setError(null); setUnchecked(null); setPreview(null); setRequestId(null);
    const outcome = await reader.read(async (signal) => {
      const result = await previewRecipePlan(recipe.recipeId, date, slotId, fraction, signal);
      if (result.recipe.revisionId !== recipe.revisionId) {
        throw new Error("This recipe changed. Refresh the results before planning it.");
      }
      return result;
    });
    if (outcome.status === "superseded") return;
    setBusy(false);
    if (outcome.status === "failed") {
      const mark = rulesUncheckedMark(outcome.error);
      if (mark) setUnchecked(mark);
      else setError(outcome.error instanceof Error ? outcome.error.message : "Preview failed.");
    }
  }
  async function accept() {
    if (!preview) return;
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id); setBusy(true); setError(null);
    const inputs = recipeRuleInputs();
    try {
      const selection = await acceptRecipePlan(recipe.recipeId, preview.previewId, id, !preview.exactFitAvailable);
      // Written: a later rule change marks it Checking, and nothing redoes the write.
      reader.clear();
      setSavedMark(selection?.ruleMark ?? null);
      setSavedInputs(inputs);
      setSaved(true);
      window.dispatchEvent(new Event("recipe-plan-accepted"));
      onPlanned?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add the recipe."); }
    finally { setBusy(false); }
  }
  return <section className="shell" aria-label={`Plan ${recipe.name}`}><div className="surface flex flex-col gap-3 p-4">
    <div className="flex items-center justify-between"><h3 className="m-0 text-base font-semibold">Adjust portion · {recipe.name}</h3>
      <Button onClick={onClose}>Close</Button></div>
    {saved ? <>
      <Notice tone="success" title="Added to the plan.">
        <Link href="/foods#shopping" className="tap underline">Plan groceries in Shopping</Link></Notice>
      <RuleMark mark={verdictNow(savedMark, savedInputs, inputsNow)} />
    </> : <>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm">Date<DateField label="Date" className="mt-1 min-h-11 w-full px-2" value={date}
          onChange={(next) => { setDate(next ?? ""); dropPreview(); }} /></label>
        <div className="text-sm"><span>Meal</span><GlassSelect aria-label="Meal" className="mt-1" value={slotId}
          onChange={(next) => { setSlotId(next); dropPreview(); }}
          options={Array.from({ length: 6 }, (_, index) => ({ value: `meal-${index + 1}`, label: `Meal ${index + 1}` }))} /></div>
      </div>
      <label className="text-sm">Serving amount (blank asks for a meal-target suggestion)<input type="number" className="well mt-1 min-h-11 w-full px-2"
        min={recipe.minServingFraction} max={recipe.maxServingFraction} step="0.1" value={fraction ?? ""}
        onChange={(event) => { setFraction(event.target.value ? Number(event.target.value) : undefined); dropPreview(); }} /></label>
      <Button variant="primary" disabled={busy || !date || (fraction !== undefined && (!Number.isFinite(fraction)
        || fraction < recipe.minServingFraction || fraction > recipe.maxServingFraction))}
        onClick={() => void prepare()}>{busy ? <Thinking size="compact" label="Working…" /> : "Preview portion"}</Button>
      {unchecked && <Notice tone="attention" title={ruleMarkReason(unchecked)} />}
      {preview && <div className="flex flex-col gap-2" aria-label="Portion preview">
        {/* This recipe and its adapted lines under the current rules; it never blocks the add. */}
        <RuleMark mark={previewStale || judgedRulesKey(preview) !== phoneRulesKey() ? RECIPE_RECHECK_MARK
          : verdictNow(preview.ruleMark, previewInputs, inputsNow)} />
        <p className="m-0 text-sm">{preview.exactFitAvailable ? "Revision-backed portion" :
          "Approximate portion based on sourced estimates"}. Suggested amount: {displayAmount(preview.servingFraction, 2)} serving{preview.servingFraction === 1 ? "" : "s"}. All ingredients keep the same ratio.</p>
        <p className="m-0 text-sm">Meal target for {date}, Meal {slotId.slice(5)}: {preview.mealTarget
          ? <KcalText text={`${displayAmount(preview.mealTarget.kcal)} kcal · ${displayAmount(preview.mealTarget.protein)} g protein · ${displayAmount(preview.mealTarget.carbs)} g carbs · ${displayAmount(preview.mealTarget.fat)} g fat`} />
          : "not available"}.</p>
        <ul className="m-0 list-disc pl-5 text-sm">{preview.ingredientSnapshot.map((item) => <li key={item.seq}>
          {recipe.ingredients.find((source) => source.seq === item.seq)?.name ?? `Ingredient ${item.seq}`}: {displayAmount(item.quantity, 2)} {item.unit}
        </li>)}</ul>
        <dl className="grid grid-cols-2 gap-2 text-sm">{RECIPE_MACROS.map((key) => <div key={key}>
          <dt>{key}</dt><dd className="m-0">{preview.nutritionSnapshot[key]?.status === "unknown" || preview.nutritionSnapshot[key]?.value === null || preview.nutritionSnapshot[key]?.value === undefined
            ? "Missing evidence" : `${displayAmount(preview.nutritionSnapshot[key].value!)}${key === "kcal" ? " kcal" : " g"}`}
            {preview.nutritionSnapshot[key]?.status === "estimated" ? " · estimated" : ""}
            {preview.nutritionSnapshot[key]?.status !== "unknown" && preview.gap[key] !== null ? ` · ${displayAmount(Math.abs(preview.gap[key]!))}${key === "kcal" ? " kcal" : " g"} ${preview.gap[key]! >= 0 ? "above" : "below"} target` : ""}</dd></div>)}</dl>
        {preview.evidenceIssues.length > 0 && <div className="text-sm">
          <p className="m-0">{evidenceSummary(preview.evidenceIssues)} {preview.approximateFitAvailable
            ? "Nutrition is an estimate, not an exact fit." : "Missing evidence prevents a reliable portion preview."}</p>
          <Disclosure variant="row" size="sm" title="Evidence details" bodyClassName="pb-2">
            <ul className="m-0 list-disc pl-5">{distinctEvidenceIssues(preview.evidenceIssues).map((issue, index) =>
              <li key={`${issue.code}:${issue.ingredientSeq ?? index}`}>{issue.message}</li>)}</ul>
          </Disclosure></div>}
        <Button variant="primary" disabled={busy || !preview.approximateFitAvailable}
          onClick={() => void accept()}>{busy ? "Saving…" : preview.exactFitAvailable
            ? "Add to plan" : "Accept approximate portion and add"}</Button>
      </div>}
    </>}
    {error && <Notice tone="error" title={error} />}
  </div></section>;
}
