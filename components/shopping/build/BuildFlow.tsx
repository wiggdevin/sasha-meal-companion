"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import AutoHeight from "@/components/ui/AutoHeight";
import Button from "@/components/ui/Button";
import CloseButton from "@/components/ui/CloseButton";
import Notice from "@/components/ui/Notice";
import { BUILD_STEPS, buildReducer, initialBuildState, newSaveProgress, previewInput, runSave, savePlan,
  STEP_LABEL, type MealCard, type SaveDeps, type SaveProgress } from "@/lib/shopping/build-flow";
import type { BuildCandidate } from "@/lib/shopping/build-candidates";
import type { ShoppingDraft, ShoppingPreviewInput } from "@/lib/shopping/contracts";
import type { Provenance } from "@/lib/types";
import StepBudget from "./StepBudget";
import StepIngredients from "./StepIngredients";
import StepMeals from "./StepMeals";
import StepSave, { type SaveStatus } from "./StepSave";
import StepStores, { type PlacesPort } from "./StepStores";
import styles from "./build.module.css";

export type DeckLoad = { cards: BuildCandidate[]; leftOutByRules: number; total: number;
  /** Saved-recipe ingredients that could not be named on this phone. */
  unnamed?: number; provenance: Provenance };

/** Everything the flow reads or writes, injected (components/shopping/BuildListCard.tsx wires the real ones). */
export type BuildFlowPorts = {
  loadDeck: () => Promise<DeckLoad>;
  /** Write-free: the planner's preview for these days, as meal cards. */
  preview: (input: ShoppingPreviewInput) => Promise<{ previewId: string; cards: MealCard[] }>;
  save: SaveDeps;
  places?: PlacesPort;
};

export const LIST_SAVED_EVENT = "shopping-list-saved";
export const RECIPE_PLAN_ACCEPTED_EVENT = "recipe-plan-accepted";

/**
 * The "Have AI build my list" flow (UI makeover §7.3), opened in place on Shopping: Budget →
 * Foods → Meals → Stores → Save, a five-step rail and "Step 2 of 5" so the place in the flow is
 * always plain, Back on every step after the first, and Close, which drops everything. Nothing is
 * written until Save list.
 *
 * Only a finished save opens the new list on Shopping (`shopping-list-saved`): opening it remounts
 * this flow, so a save that stopped part-way keeps the flow and "Finish saving", and its list opens
 * when the flow is closed. Close is off while a save is in flight.
 */
export default function BuildFlow({ accountId, countryCode, mealCount, initialDraft, ports, onClose, onSaved }: {
  accountId: string;
  countryCode: string | null;
  mealCount: number;
  initialDraft: ShoppingDraft;
  ports: BuildFlowPorts;
  onClose: () => void;
  onSaved: (periodId: string) => void;
}) {
  const [state, dispatch] = useReducer(buildReducer, initialDraft, initialBuildState);
  const [deckError, setDeckError] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const progress = useRef<SaveProgress | null>(null);
  const portsRef = useRef(ports);
  const live = useRef(true);
  const stepIndex = BUILD_STEPS.indexOf(state.step);
  const saved = saveStatus.kind === "partial";
  const saving = saveStatus.kind === "saving";

  useEffect(() => { portsRef.current = ports; }, [ports]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    void portsRef.current.loadDeck().then((deck) => {
      if (live.current) dispatch({ type: "deck-loaded", ...deck });
    }).catch(() => {
      if (!live.current) return;
      setDeckError(true);
      dispatch({ type: "deck-loaded", cards: [], leftOutByRules: 0, total: 0, provenance: { ai: false, source: "app" } });
    });
  }, []);

  const request = state.meals.request;
  const loading = state.meals.status === "loading";
  const input = previewInput(state);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; });
  useEffect(() => {
    if (!loading) return;
    void portsRef.current.preview(inputRef.current).then((answer) => {
      if (live.current) dispatch({ type: "preview-loaded", request, ...answer });
    }).catch((cause: unknown) => {
      if (live.current) dispatch({ type: "preview-failed", request,
        message: cause instanceof Error && cause.message ? cause.message : "Meals could not be planned. Try again." });
    });
  }, [request, loading]);

  async function save() {
    if (saving) return;
    const plan = savePlan(state);
    if (!plan) { setSaveStatus({ kind: "error", message: "Plan the meals first." }); return; }
    const deps = portsRef.current.save;
    const start = progress.current ?? newSaveProgress(deps.newId);
    progress.current = start;
    setSaveStatus({ kind: "saving" });
    try {
      const result = await runSave(plan, start, deps);
      progress.current = result.progress;
      if (!live.current) return;
      const periodId = result.progress.period!.id;
      if (result.status === "done") { announce(periodId); onSaved(periodId); }
      else setSaveStatus({ kind: "partial", failed: result.failed });
    } catch (cause) {
      if (!live.current) return;
      setSaveStatus({ kind: "error", message: cause instanceof Error && cause.message
        ? cause.message : "The list did not save. Try again." });
    }
  }

  /** Tells Shopping a list was saved, which opens it (and remounts this flow). */
  function announce(periodId: string) {
    window.dispatchEvent(new Event(RECIPE_PLAN_ACCEPTED_EVENT));
    window.dispatchEvent(new CustomEvent(LIST_SAVED_EVENT, { detail: { periodId } }));
  }
  function close() {
    if (saving) return;
    // A list saved part-way is still a list: closing opens it.
    const periodId = progress.current?.period?.id;
    if (saved && periodId) announce(periodId);
    onClose();
  }

  let body;
  switch (state.step) {
    case "budget":
      body = <StepBudget amount={state.draft.budgetAmount} currency={state.draft.currency} countryCode={countryCode}
        onSkip={() => dispatch({ type: "skip" })}
        onNext={(amount, currency) => { dispatch({ type: "budget", amount, currency }); dispatch({ type: "next" }); }} />;
      break;
    case "ingredients":
      body = <>
        {deckError && <Notice tone="error" title="Your foods could not load. You can still plan meals." />}
        {state.ingredients.unnamed > 0 && (
          <p className="m-0 text-caption text-muted">
            {state.ingredients.unnamed} recipe {state.ingredients.unnamed === 1 ? "ingredient" : "ingredients"} could
            not be named on this phone, so {state.ingredients.unnamed === 1 ? "it is" : "they are"} not shown.</p>
        )}
        <StepIngredients state={state} dispatch={dispatch} />
      </>;
      break;
    case "meals":
      body = <StepMeals state={state} dispatch={dispatch} mealCount={mealCount} />;
      break;
    case "stores":
      body = <StepStores accountId={accountId} countryCode={countryCode} picked={state.stores}
        places={ports.places}
        onToggle={(store) => dispatch({ type: "toggle-store", store })}
        onNext={() => dispatch({ type: "next" })} onSkip={() => dispatch({ type: "skip" })} />;
      break;
    case "save":
      body = <StepSave state={state} dispatch={dispatch} mealCount={mealCount} status={saveStatus}
        onSave={() => { void save(); }} />;
      break;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-caption text-muted" aria-live="polite">
          Step {stepIndex + 1} of {BUILD_STEPS.length} · {STEP_LABEL[state.step]}
        </p>
        <CloseButton onClick={close} disabled={saving} label={saved ? "Close" : "Close without saving"} />
      </div>
      <ol className={styles.rail} aria-hidden="true">
        {BUILD_STEPS.map((step, index) => (
          <li key={step} className={`${styles.railStep} ${index < stepIndex ? styles.railDone : ""} ${
            index === stepIndex ? styles.railCurrent : ""}`} />
        ))}
      </ol>
      <AutoHeight>
        <div className="flex flex-col gap-3">{body}</div>
      </AutoHeight>
      {stepIndex > 0 && !saving && saveStatus.kind !== "partial" && (
        <Button variant="ghost" className="self-start" onClick={() => dispatch({ type: "back" })}>Back</Button>
      )}
    </div>
  );
}
