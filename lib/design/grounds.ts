/**
 * The four selectable backgrounds (DESIGN.md §Grounds). A ground moves only the bare page behind the
 * cards: its base colour (`--color-paper`, `--color-background`), the lighter wash at the top and
 * the shade in the lower corner of `.harvest-ground`. Cards, the matte meal card and the dock keep
 * their own colours. The same hex values are written in `app/globals.css` (`html[data-ground]`);
 * `tests/design/grounds.test.ts` holds the two equal and checks contrast on every ground.
 */
export type GroundId = "oat" | "sage" | "clay" | "mist";

export type Ground = {
  id: GroundId;
  label: string;
  /** The bare page and the browser chrome colour. */
  base: string;
  /** The lighter wash at the top edge. */
  lift: string;
  /** The darker wash in the lower right corner. */
  shade: string;
};

export const GROUNDS: readonly Ground[] = [
  { id: "oat", label: "Oat", base: "#e0dcd1", lift: "#ece8de", shade: "#d3cdc0" },
  { id: "sage", label: "Sage", base: "#e1e5d6", lift: "#edf0e4", shade: "#d1d8c3" },
  { id: "clay", label: "Clay", base: "#e9ddd2", lift: "#f3ebe3", shade: "#dccdbf" },
  { id: "mist", label: "Mist", base: "#dfe3e2", lift: "#ebeeee", shade: "#cdd5d6" },
];

export const DEFAULT_GROUND: GroundId = "oat";

export function isGroundId(value: unknown): value is GroundId {
  return GROUNDS.some((g) => g.id === value);
}

export function groundById(id: GroundId): Ground {
  return GROUNDS.find((g) => g.id === id) ?? GROUNDS[0];
}
