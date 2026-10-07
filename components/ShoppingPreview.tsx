"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { identityKey } from "@/lib/shopping/aggregate";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { IngredientIdentity, ShoppingLine, ShoppingPeriod } from "@/lib/shopping/types";
import type { ShoppingPreviewResult } from "@/lib/shopping/preview-contract";
import { displayAmount } from "@/lib/recipes/preview-display";
import Notice from "@/components/ui/Notice";
import RuleMark from "@/components/ui/RuleMark";
import { ProteinShort } from "@/components/nutrition/MacroText";
import { proteinShortGrams } from "@/lib/nutrition-display";
import { sameRuleMark } from "@/lib/rule-mark";

export type ShoppingPreviewData = {
  period: ShoppingPeriod;
  lines: ShoppingLine[];
  issues: string[];
  blockingIssues?: string[];
  unmetPins: string[];
  choices?: AcceptedRecipeSelection[];
  windows?: ShoppingPreviewResult["windows"];
  replenishment?: ShoppingPreviewResult["replenishment"];
  unfilledSlots?: ShoppingPreviewResult["unfilledSlots"];
  proposedAdditions?: string[];
  compromise?: string[];
  price?: ShoppingPreviewResult["price"];
  /** The adapter owns revision and idempotency checks. */
  accept: () => Promise<void>;
};

function amount(line: ShoppingLine): string {
  if (line.buyGrams !== null) return `${displayAmount(line.buyGrams)} g to buy`;
  if (line.needGrams !== null) return `${displayAmount(line.needGrams)} g needed · package amount to buy unknown`;
  return "purchase amount unknown";
}
const mealLabel = (slot: string) => /^meal-[1-6]$/.test(slot) ? `Meal ${slot.slice(5)}` : slot;
function lineKey(line: ShoppingLine): string {
  return line.origin === "plan" && line.identity ? `plan:${identityKey(line.identity)}` : `row:${line.id}`;
}

export default function ShoppingPreview({ current, basket, confirmedPantry = [], preview, onAccepted, onCancel }: {
  current: ShoppingLine[]; basket?: IngredientIdentity[]; confirmedPantry?: IngredientIdentity[]; preview: ShoppingPreviewData; onAccepted: () => void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oldById = new Map(current.map((line) => [lineKey(line), line]));
  const nextById = new Map(preview.lines.map((line) => [lineKey(line), line]));
  const added = preview.lines.filter((line) => !oldById.has(lineKey(line)));
  const amountsChanged = (old: ShoppingLine, line: ShoppingLine) =>
    old.needGrams !== line.needGrams || old.buyGrams !== line.buyGrams || old.checked !== line.checked;
  // A line whose rule mark moved is a change too: a line newly off the rules must be seen before Accept.
  const changed = preview.lines.filter((line) => {
    const old = oldById.get(lineKey(line));
    return old && (amountsChanged(old, line) || !sameRuleMark(old.ruleMark, line.ruleMark));
  });
  const removed = current.filter((line) => !nextById.has(lineKey(line)));
  const preservationIssues = current.flatMap((line) => {
    const next = nextById.get(lineKey(line));
    if (!next && (line.origin === "manual" || line.checked || line.note))
      return [`${line.name}: a manual item, bought mark or note would be lost.`];
    if (next && next.note !== line.note) return [`${line.name}: a note would change.`];
    if (next && line.checked && !next.checked && (next.needGrams ?? 0) <= (line.needGrams ?? 0))
      return [`${line.name}: a bought mark would reset without increased need.`];
    return [];
  });
  const allowed = new Set([...(basket ?? current.filter((line) => line.identity).map((line) => line.identity!)),
    ...confirmedPantry].map(identityKey));
  const lockIssues = preview.period.lockMode === "none" ? [] : preview.lines
    .filter((line) => line.origin === "plan" && line.identity && !allowed.has(identityKey(line.identity)))
    .map((line) => `${line.name}: outside the selected basket and confirmed pantry.`);
  const blockingIssues = [...new Set([...(preview.blockingIssues ?? []), ...preservationIssues, ...lockIssues])];
  const notes = [...new Set(preview.issues)].filter((issue) => !preview.compromise?.includes(issue));
  async function accept() {
    setBusy(true); setError(null);
    try { await preview.accept(); onAccepted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The plan changed. Refresh and preview again."); }
    finally { setBusy(false); }
  }
  return <section className="shell" aria-label="Plan and shopping preview"><div className="surface flex flex-col gap-3 p-4">
    <h2 className="m-0 text-lg font-semibold">Review the list change</h2>
    <p className="ground-muted m-0 text-sm">Saved plans and the current list change only after you accept. Manual items, bought marks and notes must carry through.</p>
    {blockingIssues.length > 0 && <div role="alert"><h3 className="mb-1 text-sm font-semibold">Changes needed before acceptance</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{blockingIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
    {notes.length > 0 && <div><h3 className="mb-1 text-sm font-semibold">Estimates and notes</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{notes.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
    {preview.unmetPins.length > 0 && <div role="alert"><h3 className="mb-1 text-sm font-semibold">Pins not met</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{preview.unmetPins.map((pin, index) => <li key={index}>{pin}</li>)}</ul></div>}
    {preview.choices && <section aria-label="Meal choices"><h3 className="mb-1 text-sm font-semibold">Meal choices</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{preview.choices.map((choice, index) => <li key={`${choice.localDate}:${choice.slotId}:${index}`}>
        {choice.localDate} · {mealLabel(choice.slotId)}: {choice.recipeName} · {displayAmount(choice.servingFraction, 2)} serving{choice.servingFraction === 1 ? "" : "s"}
        {proteinShortGrams(choice.proteinGapGrams) !== null && <>{" · "}<ProteinShort gap={choice.proteinGapGrams} /></>}</li>)}</ul></section>}
    {(preview.replenishment?.length ?? 0) > 1 && <section aria-label="Weekly shopping needs">
      <h3 className="mb-1 text-sm font-semibold">Weekly shopping needs</h3>
      {preview.replenishment?.map((entry) => <div key={entry.window.startDate}>
        <h4 className="mb-1 text-sm font-semibold">{entry.window.startDate} – {entry.window.endDate}</h4>
        <ul className="m-0 list-disc pl-5 text-sm">{entry.lines.map((part) => {
          const line = preview.lines.find((item) => item.id === part.lineId);
          return <li key={part.lineId}>{line?.name ?? "Ingredient"}: {part.needGrams === null ? "need unknown" : `${displayAmount(part.needGrams)} g needed`}
            {" · "}{part.buyGrams === null ? "package amount to buy unknown" : `${displayAmount(part.buyGrams)} g to buy`}
            {part.checked ? " · already marked bought" : ""}
            {line?.ruleMark && <> <RuleMark mark={line.ruleMark} variant="tag" className="align-middle" /></>}</li>;
        })}</ul>
      </div>)}
      <p className="ground-muted m-0 text-sm">Each week shows its own need and proposed purchase amount.</p>
    </section>}
    {(preview.proposedAdditions?.length ?? 0) > 0 && <section><h3 className="mb-1 text-sm font-semibold">Proposed ingredients</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{preview.proposedAdditions?.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    {(preview.unfilledSlots?.length ?? 0) > 0 && <section role="alert"><h3 className="mb-1 text-sm font-semibold">Meals this plan cannot fill</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{preview.unfilledSlots?.map((slot) =>
        <li key={`${slot.localDate}:${slot.slotId}`}>{slot.localDate} · {mealLabel(slot.slotId)}: {slot.reasons.join("; ")}</li>)}</ul></section>}
    {(preview.compromise?.length ?? 0) > 0 && <section><h3 className="mb-1 text-sm font-semibold">Plan tradeoffs</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{preview.compromise?.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    <div className="grid grid-cols-3 gap-2 text-sm"><span>Add {added.length}</span><span>Change {changed.length}</span><span>Remove {removed.length}</span></div>
    {added.length > 0 && <section><h3 className="mb-1 text-sm font-semibold">Added</h3><ul className="m-0 list-disc pl-5 text-sm">{added.map((line) => <li key={line.id}>{line.name} · {amount(line)}
      <RuleMark mark={line.ruleMark} className="mt-1 flex-wrap" /></li>)}</ul></section>}
    {changed.length > 0 && <section><h3 className="mb-1 text-sm font-semibold">Changed</h3><ul className="m-0 list-disc pl-5 text-sm">{changed.map((line) => {
        const old = oldById.get(lineKey(line))!;
        return <li key={line.id}>{line.name} · {amountsChanged(old, line) ? `${amount(old)} → ${amount(line)}` : amount(line)}
          {old.ruleMark && !line.ruleMark ? " · no longer marked against your food rules" : ""}
          <RuleMark mark={line.ruleMark} className="mt-1 flex-wrap" /></li>;
      })}</ul></section>}
    {removed.length > 0 && <section><h3 className="mb-1 text-sm font-semibold">Removed</h3><ul className="m-0 list-disc pl-5 text-sm">{removed.map((line) => <li key={line.id}>{line.name}
      <RuleMark mark={line.ruleMark} className="mt-1 flex-wrap" /></li>)}</ul></section>}
    <p className="ground-muted m-0 text-sm">{preview.price?.estimatedCheckoutAmount !== null
      && preview.price?.estimatedCheckoutAmount !== undefined && preview.price.pricedLines === preview.price.requiredLines
      ? `Estimated checkout: ${preview.price.currency ?? ""} ${preview.price.estimatedCheckoutAmount}.`
      : `Price coverage: ${preview.price?.pricedLines ?? 0} of ${preview.price?.requiredLines ?? preview.lines.length} required lines. No verified checkout total.`}
      {preview.price?.budgetMet === null || preview.price?.budgetMet === undefined
        ? " Budget fit is unknown." : preview.price.budgetMet ? " Within the entered budget estimate." : " Above the entered budget estimate."}</p>
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || blockingIssues.length > 0}
      onClick={() => void accept()}>{busy ? "Accepting…" : "Accept plan and list"}</Button>
      <Button disabled={busy} onClick={onCancel}>Keep current plan</Button></div>
    {error && <Notice tone="error" title={error} />}
  </div></section>;
}
