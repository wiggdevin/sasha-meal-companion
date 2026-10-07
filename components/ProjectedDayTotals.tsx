import type { Macros } from "@/lib/types";

export type DayProjection = { consumed: Macros; targets: Macros | null };

const ROWS: { key: keyof Macros; label: string; unit: string }[] = [
  { key: "kcal", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
];

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** A live preview of the account's own day after this food or meal is logged. */
export default function ProjectedDayTotals({ projection, added, replaced, label = "If logged" }: {
  projection: DayProjection;
  added: Macros | null;
  replaced?: Macros;
  label?: string;
}) {
  if (!projection.targets) return <p className="m-0 text-caption text-muted">Daily targets unavailable until your profile is complete.</p>;
  if (!added) return <p className="m-0 text-caption text-muted">Nutrition data unavailable for this projection.</p>;

  return <section className="surface rounded-[16px] p-4" aria-label="Projected day totals">
    <h3 className="m-0 mb-2 text-caption font-medium text-charcoal">{label}</h3>
    <div className="grid grid-cols-1 gap-1.5 text-caption tabular-nums min-[360px]:grid-cols-2">
      {ROWS.map(({ key, label: rowLabel, unit }) => {
        const before = projection.consumed[key];
        const target = projection.targets![key];
        const after = Math.max(0, before - (replaced?.[key] ?? 0) + added[key]);
        const over = target > 0 && after > target;
        // Calorie figures take the shared calorie colour, unless the row is over and says so in red.
        const n = (value: number) => key === "kcal" && !over
          ? <span className="kcal font-semibold">{fmt(value)}</span> : fmt(value);
        return <p key={key} className={`m-0 ${over ? "text-alert" : "text-graphite"}`}
          data-over-goal={over ? key === "kcal" ? "calories" : key : undefined}
          aria-label={`${rowLabel} ${fmt(before)} to ${fmt(after)} of ${fmt(target)} ${unit}${over ? `, ${fmt(after - target)} ${unit} over` : ""}`}>
          {rowLabel} {n(before)} → {n(after)} / {n(target)} {unit}
        </p>;
      })}
    </div>
  </section>;
}
