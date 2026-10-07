"use client";

/**
 * Grams / percent toggle plus three steppers, opened from Settings (spec "Client changes").
 * In percent mode it shows the percentages the user entered AND the grams they produce for a training
 * day and a rest day, live, from the same pure functions the server uses for authority.
 */
import { useId, useState } from "react";
import Sheet from "@/components/Sheet";
import Stepper from "@/components/Stepper";
import Button from "@/components/ui/Button";
import Segmented, { tabId } from "@/components/ui/Segmented";
import {
  applyFloors, percentToGrams, validatePercentProfile,
  type GramTargets, type MacroFloors, type MacroPercents,
} from "@/lib/targets/percent";
import type { TargetsRequest } from "@/lib/api-types";

export type Preview =
  | { ok: true; training: GramTargets; rest: GramTargets;
      error?: undefined; minProteinPct?: undefined; minFatPct?: undefined }
  | { ok: false; error: string; minProteinPct: number; minFatPct: number;
      training: GramTargets; rest: GramTargets };

export function previewGrams(
  kcalTrain: number, kcalRest: number, pct: MacroPercents, floors: MacroFloors,
): Preview {
  const training = applyFloors(kcalTrain, percentToGrams(kcalTrain, pct), floors).grams;
  const rest = applyFloors(kcalRest, percentToGrams(kcalRest, pct), floors).grams;
  const check = validatePercentProfile(pct, kcalTrain, kcalRest, floors);
  return check.ok
    ? { ok: true, training, rest }
    : { ok: false, error: check.error, minProteinPct: check.minProteinPct,
        minFatPct: check.minFatPct, training, rest };
}

const line = (label: string, g: GramTargets) =>
  `${label}: ${g.proteinG} g protein · ${g.fatG} g fat · ${g.carbG} g carbs`;

export default function TargetModeSheet({ initial, floors, saveError, onClose, onSave }: {
  initial: { mode: "grams" | "percent"; kcalTrain: number; kcalRest: number;
    grams: GramTargets; percent: MacroPercents };
  floors: MacroFloors;
  saveError?: string | null;
  onClose: () => void;
  onSave: (req: TargetsRequest) => void;
}) {
  const [mode, setMode] = useState(initial.mode);
  const [pct, setPct] = useState<MacroPercents>(initial.percent);
  const [grams, setGrams] = useState<GramTargets>(initial.grams);

  const preview = previewGrams(initial.kcalTrain, initial.kcalRest, pct, floors);
  const today = new Date().toISOString().slice(0, 10);
  const panelId = useId();

  function save() {
    onSave(mode === "percent"
      ? { mode, effectiveFrom: today, kcalTrain: initial.kcalTrain,
          kcalRest: initial.kcalRest, percent: pct }
      : { mode, effectiveFrom: today, kcalTrain: initial.kcalTrain,
          kcalRest: initial.kcalRest, grams });
  }

  return (
    <Sheet title="Targets" subtitle="Grams, or percentages of the day" onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {saveError && (
            <p className="m-0 text-tiny font-normal text-alert">
              {saveError}
            </p>
          )}
          <Button variant="primary" size="lg" block onClick={save} disabled={mode === "percent" && !preview.ok}>
            Save targets
          </Button>
        </div>
      }>
      <div className="flex flex-col gap-5">
        {/* The system segmented control: the olive lens marks the unit (it used to be a weight change
            only, too faint to read as chosen). */}
        <div className="self-start">
          <Segmented label="Target units" value={mode} onChange={setMode} panel={panelId}
            options={[{ value: "grams", label: "Grams" }, { value: "percent", label: "Percent" }]} />
        </div>
        <div id={panelId} role="tabpanel" aria-labelledby={tabId(mode)} className="flex flex-col gap-5">
          {mode === "percent" ? (
            <>
              <Stepper label="Protein" value={pct.proteinPct} step={1} unit="%"
                onChange={(v) => setPct({ ...pct, proteinPct: v })} />
              <Stepper label="Fat" value={pct.fatPct} step={1} unit="%"
                onChange={(v) => setPct({ ...pct, fatPct: v })} />
              <Stepper label="Carbs" value={pct.carbPct} step={1} unit="%"
                onChange={(v) => setPct({ ...pct, carbPct: v })} />
            </>
          ) : (
            <>
              <Stepper label="Protein" value={grams.proteinG} step={5} unit="g"
                onChange={(v) => setGrams({ ...grams, proteinG: v })} />
              <Stepper label="Fat" value={grams.fatG} step={5} unit="g"
                onChange={(v) => setGrams({ ...grams, fatG: v })} />
              <Stepper label="Carbs" value={grams.carbG} step={5} unit="g"
                onChange={(v) => setGrams({ ...grams, carbG: v })} />
            </>
          )}

          {mode === "percent" && (
            <div className="well flex flex-col gap-1 px-4 py-3">
              <span className="text-tiny font-normal text-muted">
                {line("Training day", preview.training)}
              </span>
              <span className="text-tiny font-normal text-muted">
                {line("Rest day", preview.rest)}
              </span>
              {!preview.ok && (
                <span className="text-tiny font-normal text-charcoal">
                  {preview.error === "percent_sum"
                    ? "The three percentages must add up to 100."
                    : preview.error === "protein_below_floor"
                      ? `Protein needs at least ${preview.minProteinPct} %.`
                      : `Fat needs at least ${preview.minFatPct} %.`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
