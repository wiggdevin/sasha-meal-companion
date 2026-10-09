"use client";

/**
 * Onboarding v2: the one tappable tile grid (owner, 2026-10-08: "the same square-tile grid as the
 * confirmation page"). The food step's end grid and "Just pick from the list", and the practice,
 * stay-away and cuisine questions' list, all render this; nothing copies it. Each tile is a
 * `FoodDisc` (art when its id has some, a short-name circle otherwise), ≥ 44 px, pressed state on a
 * ring and a check badge so a pick reads at a glance on the matte shell.
 */
import FoodDisc from "./FoodDisc";

export type Tile = {
  id: string;
  /** The short on-screen caption. */
  label: string;
  /** The full accessible name ("Love Chicken breast, roasted", "Halal"). */
  ariaLabel: string;
};

const COLUMNS = { 3: "grid-cols-3", 4: "grid-cols-4" } as const;

export default function TileGrid({ tiles, selected, onToggle, columns = 4, size = "sm", testId = "tile-grid" }: {
  tiles: readonly Tile[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, next: boolean) => void;
  columns?: keyof typeof COLUMNS;
  size?: "sm" | "md";
  testId?: string;
}) {
  return <div className={`grid w-full ${COLUMNS[columns]} justify-items-center gap-x-1 gap-y-2`} data-testid={testId}>
    {tiles.map((tile) => {
      const pressed = selected.has(tile.id);
      return <FoodDisc key={tile.id} id={tile.id} shortName={tile.label} size={size}
        label={tile.ariaLabel} pressed={pressed} variant={pressed ? "primary" : "tertiary"}
        onToggle={() => onToggle(tile.id, !pressed)} />;
    })}
  </div>;
}
