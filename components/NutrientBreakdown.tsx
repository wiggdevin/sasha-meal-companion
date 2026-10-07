"use client";

import { fmt } from "@/lib/log/catalog-card";
import { formatAmount } from "@/lib/nutrients/format";
import { totalsFor } from "@/lib/nutrients/totals";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import { PARTIAL_NOTE } from "@/lib/nutrition-display";
import type { LoggedFood } from "@/lib/types";

/**
 * Every nutrient of one logged entry — phase-2-real-logging.md, Client changes. A `—` means the
 * source measured nothing; a `0` means it measured zero. The source and its version sit at the
 * foot so an fdc.nal.usda.gov check is a comparison, not a hunt.
 */
export default function NutrientBreakdown({ entry }: { entry: LoggedFood }) {
  const items = entry.items ?? [];
  const measured = items.filter((i) => Object.keys(i.snapshot ?? {}).length > 0) as {
    snapshot: Snapshot;
  }[];
  const totals = totalsFor(measured);
  if (totals.size === 0) return null;

  const first = measured[0];
  const anyValue = Object.values(first.snapshot)[0];
  if (!anyValue) return null;

  return (
    <section className="surface rounded-[16px] p-4" aria-label={`Nutrients in ${entry.name}`}>
      <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">
        {/* The mass is unknown (t17): `entry.grams` is a placeholder, never the amount — the count
            and its own unit are, never "0 g". */}
        {entry.massUnknown ? `${fmt(entry.qty)} × ${entry.portionLabel}` : `${entry.grams} g`}
        {" · "}{measured.length} measured item{measured.length === 1 ? "" : "s"}
        {entry.massUnknown && ` · ${PARTIAL_NOTE}`}
      </p>
      <dl className="flex flex-col gap-1.5">
        {[...totals.values()].map((t) => (
          <div key={t.code} className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-caption font-normal text-graphite">{t.code.replace(/_/g, " ")}</dt>
            <dd className="shrink-0 text-caption tabular-nums text-charcoal ">
              {formatAmount(t.code, t.itemsWithValue === 0 ? null : t.amount, t.unit)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-hairline pt-2 text-tiny font-normal text-text-faint">
        {anyValue.source} · {anyValue.source_version}
      </p>
    </section>
  );
}
