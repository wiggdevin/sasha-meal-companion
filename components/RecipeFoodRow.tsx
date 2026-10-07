"use client";

import type { SearchHit } from "@/lib/food-db";

/** One bundled-food result: the source tile, the name, and the off-plan marks. Never hidden. */
export default function RecipeFoodRow({ hit, onPick }: {
  hit: SearchHit; onPick: (hit: SearchHit) => void;
}) {
  return (
    <button type="button" onClick={() => onPick(hit)} className="pill tap w-full rounded-[16px] text-left">
      <span className="pill-in flex items-center gap-3 rounded-[16px] px-3.5 py-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] olive-panel text-tiny tracking-[0.04em] text-charcoal"
        >
          {hit.source === "mine" ? "MINE" : "USDA"}
        </span>
        <span className="flex min-w-0 flex-grow flex-col gap-0.5">
          <span className=" truncate text-caption font-normal text-charcoal">{hit.name}</span>
          <span className="truncate text-tiny font-normal text-muted">
            {hit.source === "mine" ? "Your food" : "Built in"}
            {hit.flags.length > 0 && (
              <span className="text-alert"> · off-plan: {hit.flags.join(", ")}</span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
