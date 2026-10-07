import type { Starter, StarterMark } from "./starter";

/** The daily layout uses a different protein for each generated meal. */
export function starterProteinAvailability(
  marks: Readonly<Record<string, StarterMark>>,
  choices: readonly Starter[],
  required: number,
): { selected: number; eligible: number; required: number; ready: boolean } {
  const proteins = choices.filter((item) => item.role === "protein");
  const selected = proteins.filter((item) => marks[item.id] === "eats").length;
  return { selected, eligible: proteins.length, required, ready: selected >= required };
}
