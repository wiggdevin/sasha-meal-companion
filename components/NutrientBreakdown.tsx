"use client";

import { fmt } from "@/lib/log/catalog-card";
import { nutrientLabel, visibleNutrientCodes } from "@/lib/nutrients/codes";
import { formatAmount } from "@/lib/nutrients/format";
import { totalsFor } from "@/lib/nutrients/totals";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import type { LoggedFood } from "@/lib/types";

/**
 * Every nutrient of one logged entry — phase-2-real-logging.md, Client changes. A `—` means the
 * source measured nothing; a `0` means it measured zero. The source sits at the foot in words a
 * person reads ("USDA FoodData Central", "Entered by you"); an unknown source shows no line.
 */
function sourceLine(source: string): string | null {
  if (source.startsWith("fdc")) return "Source: USDA FoodData Central";
  if (source === "off") return "Source: Open Food Facts";
  if (source === "user") return "Entered by you";
  return null;
}

export default function NutrientBreakdown({ entry }: { entry: LoggedFood }) {
  const items = entry.items ?? [];
  const measured = items.filter((i) => Object.keys(i.snapshot ?? {}).length > 0) as {
    snapshot: Snapshot;
  }[];
  const totals = totalsFor(measured);
  if (totals.size === 0) return null;
  const rows = visibleNutrientCodes([...totals.keys()], (code) => (totals.get(code)?.itemsWithValue ?? 0) > 0)
    .map((code) => totals.get(code)!);

  const first = measured[0];
  const anyValue = Object.values(first.snapshot)[0];
  if (!anyValue) return null;
  const source = sourceLine(anyValue.source);

  return (
    <section className="surface rounded-[16px] p-4" aria-label={`Nutrients in ${entry.name}`}>
      <p className="pb-2 text-tiny font-normal text-muted">
        {/* The mass is unknown (t17): `entry.grams` is a placeholder, never the amount — the count
            and its own unit are, never "0 g". */}
        {entry.massUnknown ? `${fmt(entry.qty)} × ${entry.portionLabel}` : `${fmt(entry.grams)} g`}
        {" · "}{measured.length} measured item{measured.length === 1 ? "" : "s"}
        {entry.massUnknown && " · Partly measured"}
      </p>
      <dl className="flex flex-col gap-1.5">
        {rows.map((t) => (
          <div key={t.code} className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-caption font-normal text-graphite">{nutrientLabel(t.code)}</dt>
            <dd className="shrink-0 text-caption tabular-nums text-charcoal ">
              {formatAmount(t.code, t.itemsWithValue === 0 ? null : t.amount, t.unit)}
            </dd>
          </div>
        ))}
      </dl>
      {source && (
        <p className="mt-3 border-t border-hairline pt-2 text-tiny font-normal text-text-faint">{source}</p>
      )}
    </section>
  );
}
