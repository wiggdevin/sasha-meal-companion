import type { Macros } from "@/lib/types";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

type MeterSpec = {
  label: string;
  role: string;
  value: number;
  target: number;
  unit?: "grams";
};

function TargetMeter({ label, role, value, target, unit }: MeterSpec) {
  const percent = target > 0 ? Math.max(0, Math.round((value / target) * 100)) : 0;
  const fill = Math.min(100, percent);
  const suffix = unit ? ` ${unit}` : "";

  return <div className="grid grid-cols-[68px_1fr_36px] items-center gap-2">
    <span className="text-tiny font-medium text-muted">{label}</span>
    <div role="meter" aria-label={`${label}: ${fmt(value)} of ${fmt(target)}${suffix}`}
      aria-valuemin={0} aria-valuenow={Math.round(value)} aria-valuemax={Math.round(target)}
      className="h-1 overflow-hidden rounded-full bg-selected-soft">
      <span className={`block h-full rounded-full bg-current ${role}`} style={{ width: `${fill}%` }} />
    </div>
    {/* The figure takes the gauge's readable ink shade; the bare gauge class is for the bar only. */}
    <span className={`text-right text-tiny font-semibold tabular-nums ${role.replace("macro-", "macro-ink-")}`}>{percent}%</span>
  </div>;
}

/**
 * Compact adaptation of the 21st.dev circle-menu: its radial progress concept is
 * flattened into four glanceable tracks so the expanded card stays phone-sized.
 */
export function MealTargetMeters({ meal, targets, showHeading = true }: {
  meal: Macros; targets?: Macros | null; showHeading?: boolean;
}) {
  if (!targets) return null;

  const meters: MeterSpec[] = [
    { label: "Calories", role: "macro-kcal", value: meal.kcal, target: targets.kcal },
    { label: "Protein", role: "macro-protein", value: meal.protein, target: targets.protein, unit: "grams" },
    { label: "Carbs", role: "macro-carbs", value: meal.carbs, target: targets.carbs, unit: "grams" },
    { label: "Fat", role: "macro-fat", value: meal.fat, target: targets.fat, unit: "grams" },
  ];

  return <section aria-label="Share of daily target" className="space-y-3">
    {showHeading && <h4 className="m-0 text-caption font-medium text-on-charcoal">Share of daily target</h4>}
    <div className="space-y-2.5">
      {meters.map((meter) => <TargetMeter key={meter.label} {...meter} />)}
    </div>
  </section>;
}
