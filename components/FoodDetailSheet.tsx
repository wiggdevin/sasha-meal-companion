"use client";

import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import { formatAmount } from "@/lib/nutrients/format";
import type { FoodDetail } from "@/lib/server/catalog";
import type { NutrientCode } from "@/lib/nutrients/codes";

/**
 * Read-only food detail — phase-1-catalog.md. Every number is per 100 g and `—` means the source
 * did not measure that nutrient, which is not the same as zero (architecture §3.1). The attribution
 * line is required for `off` rows (ODbL) and is shown for every source so the provenance is never
 * a special case.
 */
export default function FoodDetailSheet({
  detail, onUse, onClose,
}: {
  detail: FoodDetail;
  onUse?: (portionId: number | null) => void;
  onClose: () => void;
}) {
  const codes = Object.keys(detail.per100g);
  return (
    <Sheet
      title={detail.description}
      subtitle={detail.brand ?? detail.category ?? undefined}
      onClose={onClose}
      footer={
        onUse ? (
          <Button variant="primary" size="lg" block
            onClick={() => onUse(detail.portions.find((p) => p.isDefault)?.id ?? null)}>
            Use this food
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 px-1">
        <section className="surface rounded-[16px] p-4">
          <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Per 100 g</p>
          <dl className="flex flex-col gap-1.5">
            {codes.map((code) => (
              <div key={code} className="flex items-baseline justify-between gap-3">
                <dt className="truncate text-caption font-normal text-graphite">{code.replace(/_/g, " ")}</dt>
                <dd className="shrink-0 text-caption tabular-nums text-charcoal">
                  {formatAmount(code as NutrientCode, detail.per100g[code].amount, detail.per100g[code].unit)}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {detail.portions.length > 0 && (
          <section className="surface rounded-[16px] p-4">
            <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Portions</p>
            <ul className="flex flex-col gap-1.5">
              {detail.portions.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-caption font-normal text-graphite">{p.description}</span>
                  <span className="shrink-0 text-caption tabular-nums text-charcoal">{p.gramWeight} g</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {detail.ingredients.length > 0 && (
          <section className="surface rounded-[16px] p-4">
            <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Ingredients</p>
            <p className="text-caption font-normal text-graphite">
              {detail.ingredients.map((i) => i.name).join(", ")}
            </p>
          </section>
        )}

        <p className="px-1 text-tiny font-normal text-text-faint">
          {detail.attribution} · catalog {detail.catalogVersion}
        </p>
      </div>
    </Sheet>
  );
}
