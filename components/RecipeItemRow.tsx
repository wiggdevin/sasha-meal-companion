"use client";

import Stepper from "@/components/Stepper";
import type { RecipeItemInput } from "@/lib/recipes/nutrients";

/* Row shape from LogMeal.dc.html "In this meal": 12/14 px padding, 14 px/400 title,
   12 px/300 #6d705f meta, the serving stepper on the right. */
export default function RecipeItemRow({ item, name, onGrams, onRemove }: {
  item: RecipeItemInput; name: string; onGrams: (grams: number) => void; onRemove: () => void;
}) {
  return (
    <div className="shell">
      <div className="surface flex flex-col gap-2 rounded-2xl" style={{ padding: "12px 14px" }}>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-grow truncate text-caption font-normal">
            {name}
          </span>
          <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}
            className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-graphite">
            ×
          </button>
        </div>
        <Stepper label={`${name} grams`} value={item.grams} step={10} unit="g"
          onChange={(next) => onGrams(Math.max(0, next))} />
      </div>
    </div>
  );
}
