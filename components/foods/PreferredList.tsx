"use client";

import type { ReactNode } from "react";
import CappedList, { ListFooter } from "@/components/MyFoods.list";
import CardFrame from "@/components/ui/CardFrame";
import { aisleOf, groupByAisle } from "@/lib/foods/aisle";
import type { Food } from "@/lib/foods";

/**
 * The Foods first tab's main card (UI makeover §6): the Favored foods, grouped by aisle, starred
 * first inside each group. With the recipe pilot on it is the "Preferred shopping list" the
 * Shopping tab picks from; otherwise it is "Your favorites" (there is no Shopping tab to point at).
 * Presentational: the row, the star and the sheets stay with `EatsFoods`, which passes them in.
 */
export const PREFERRED_TITLE = "Preferred shopping list";
export const FAVORITES_TITLE = "Your favorites";

/** Starred foods first, then by name; a stable order the aisle groups keep. */
export function sortStarredFirst(foods: readonly Food[], isStarred: (food: Food) => boolean): Food[] {
  return [...foods].sort((a, b) =>
    Number(isStarred(b)) - Number(isStarred(a)) || a.name.localeCompare(b.name));
}

export default function PreferredList({ foods, pilot, isStarred, renderRow, onAdd, aside }: {
  foods: readonly Food[];
  /** The recipe pilot is on: the card is the Preferred shopping list. */
  pilot: boolean;
  isStarred: (food: Food) => boolean;
  renderRow: (food: Food, at: { last: boolean }) => ReactNode;
  onAdd: () => void;
  /** The Edit toggle, beside the title. */
  aside?: ReactNode;
}) {
  const groups = groupByAisle(sortStarredFirst(foods, isStarred), (food) => aisleOf({ name: food.name, role: food.role }));
  return (
    <CardFrame size="md" title={pilot ? PREFERRED_TITLE : FAVORITES_TITLE} aside={aside}
      meta={foods.length === 0 ? "Nothing here yet." : `${foods.length} ${foods.length === 1 ? "food" : "foods"}`}>
      {groups.map((group) => (
        <div key={group.aisle} className="flex min-w-0 flex-col" data-aisle={group.aisle}>
          <h3 className="m-0 pt-2 text-overline text-muted">{group.label}</h3>
          <CappedList items={group.items} keyOf={(food) => food.id} divided label={`${group.label} foods`}
            render={renderRow} />
        </div>
      ))}
      <ListFooter add={{ label: "Add a favorite food", onAdd }} />
    </CardFrame>
  );
}
