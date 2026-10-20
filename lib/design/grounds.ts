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
  { id: "oat", label: "Oat", base: "#dcd7cb", lift: "#e9e5db", shade: "#cdc6b8" },
  { id: "sage", label: "Sage", base: "#dce1d0", lift: "#e9ede0", shade: "#cdd4be" },
  { id: "clay", label: "Clay", base: "#e4d7cb", lift: "#efe7de", shade: "#d6c6b7" },
  { id: "mist", label: "Mist", base: "#d9dedd", lift: "#e7ebeb", shade: "#c8d0d1" },
];

export const DEFAULT_GROUND: GroundId = "oat";

export function isGroundId(value: unknown): value is GroundId {
  return GROUNDS.some((g) => g.id === value);
}

export function groundById(id: GroundId): Ground {
  return GROUNDS.find((g) => g.id === id) ?? GROUNDS[0];
}
