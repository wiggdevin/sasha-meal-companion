"use client";

import Sheet, { Pill } from "@/components/Sheet";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import ProjectedDayTotals, { type DayProjection } from "@/components/ProjectedDayTotals";
import WorkingLine from "@/components/WorkingLine";
import Button from "@/components/ui/Button";
import { kcalFor, portionPill, servingOf } from "@/lib/catalog/serving";
import type { CachedPortion, CachedRevision } from "@/lib/db/catalog-cache";
import { liveStrip } from "@/lib/log-client";
import type { Macros } from "@/lib/types";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Calories in 100 g of the revision: the serving data when the backend sent it, else its own energy. */
export function revisionKcalPer100(revision: Pick<CachedRevision, "per_100g">): number | null {
  const sent = servingOf(revision).kcalPer100g;
  if (sent !== null) return sent;
  const own = revision.per_100g.energy_kcal ?? revision.per_100g.energy_kcal_calc;
  return typeof own === "number" && Number.isFinite(own) ? own : null;
}

/**
 * The catalog portion / grams view of the log sheet — phase-2-real-logging.md.
 *
 * Grams is the resolved truth on screen: picking a portion or stepping the qty writes grams, and
 * typing grams clears the portion, so the two can never disagree. The parent owns every piece of
 * state; this file owns only the layout, so LogFoodSheet.tsx stays inside its budget.
 */
export default function LogFoodPortion({
  revision,
  portion,
  qty,
  grams,
  gramsText,
  mode,
  projection,
  mealSoFar,
  subtitle,
  canCommit,
  saving = false,
  hint,
  notice,
  onPortion,
  onQty,
  onGramsText,
  onDetails,
  onConfirm,
  onBack,
  onClose,
}: {
  revision: CachedRevision;
  portion: CachedPortion | null;
  qty: number;
  grams: number;
  gramsText: string;
  mode: "food" | "meal";
  projection?: DayProjection;
  mealSoFar?: Macros | null;
  /** The off-plan line, when the food carries flags; otherwise the brand. */
  subtitle?: string;
  canCommit: boolean;
  /** The commit is in flight: after two seconds the sheet says so, like every other save. */
  saving?: boolean;
  hint?: string | null;
  /** The commit's shared feedback toast, kept inside the dialog so its controls stay reachable. */
  notice?: React.ReactNode;
  onPortion: (p: CachedPortion) => void;
  onQty: (next: number) => void;
  onGramsText: (text: string) => void;
  /** Opens the full per-100 g detail. Absent when the food came from the offline cache. */
  onDetails?: () => void;
  onConfirm: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const strip = liveStrip(revision, grams);
  const per100 = revisionKcalPer100(revision);
  const added: Macros = {
    kcal: strip.kcal + (mealSoFar?.kcal ?? 0),
    protein: strip.protein + (mealSoFar?.protein ?? 0),
    carbs: strip.carbs + (mealSoFar?.carbs ?? 0),
    fat: strip.fat + (mealSoFar?.fat ?? 0),
  };

  return (
    <Sheet
      title={revision.description}
      subtitle={subtitle ?? revision.brand ?? undefined}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" block disabled={!canCommit} onClick={onConfirm}>
            {mode === "meal" ? "Add to meal" : "Log it"} · {fmt(grams)} g · <MacroFigure macro="kcal" value={strip.kcal} />
          </Button>
          {hint && (
            <p className="px-1.5 text-tiny text-muted" role="status">
              {hint}
            </p>
          )}
          {/* T0 §2: a save that takes more than two seconds says what it is doing. */}
          <WorkingLine active={saving} step="commit" />
          {notice}
          <Button variant="tertiary" block onClick={onBack}>Back to search</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-1">
        {revision.portions.length > 0 && (
          <div>
            <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Portion</p>
            <div className="flex flex-wrap gap-1.5">
              {/* U8: each portion says what it weighs and what it holds: "1 tbsp · 14 g · 126 kcal". */}
              {revision.portions.map((p) => (
                <Pill key={p.id} active={portion?.id === p.id} onClick={() => onPortion(p)}>
                  {portionPill({ label: p.description, grams: p.gramWeight, kcal: kcalFor(p.gramWeight, per100) })}
                </Pill>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">How many</p>
          <div className="flex items-center gap-2">
            <Button variant="tertiary" shape="circle" aria-label="Less" onClick={() => onQty(qty - 0.25)}
              className="text-subheading">−</Button>
            <span className="min-w-16 text-center text-subheading tabular-nums text-charcoal">{fmt(qty)}</span>
            <Button variant="tertiary" shape="circle" aria-label="More" onClick={() => onQty(qty + 0.25)}
              className="text-subheading">+</Button>
          </div>
        </div>

        <div>
          <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Grams</p>
          <div className="well flex h-12 items-center gap-2 px-4">
            <input
              value={gramsText}
              onChange={(e) => onGramsText(e.target.value)}
              inputMode="decimal"
              aria-label="Grams"
              className="min-w-0 flex-1 bg-transparent text-body-sm tabular-nums text-charcoal outline-none"
            />
            <span className="text-caption text-muted">g</span>
          </div>
        </div>

        <section className="surface rounded-[16px] p-4">
          <p className="text-subheading tabular-nums text-charcoal"><MacroFigure macro="kcal" value={strip.kcal} /></p>
          <p className="text-caption tabular-nums text-graphite">
            <MacroLine values={{ kcal: null, protein: strip.protein, carbs: strip.carbs, fat: strip.fat }}
              only={["protein", "carbs", "fat"]} /> · {fmt(strip.fiber)} g fibre
          </p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-tiny font-normal text-text-faint">
              {revision.source} · catalog {revision.version_label}
            </p>
            {onDetails && <Button variant="secondary" size="sm" onClick={onDetails} className="shrink-0">Details</Button>}
          </div>
        </section>
        {projection && <ProjectedDayTotals projection={projection} added={added} />}
      </div>
    </Sheet>
  );
}
