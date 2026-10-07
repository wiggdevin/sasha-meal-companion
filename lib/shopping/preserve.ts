import type { ShoppingLine } from "./types";

export type ProposedLine = ShoppingLine & { retained?: true };

/** Keep edited derived rows visible through preview; SQL converts them to manual on accept. */
export function preserveEditedLines(existing: readonly ShoppingLine[],
  proposed: readonly ShoppingLine[]): { lines: ProposedLine[]; retained: ShoppingLine[] } {
  const next = new Set(proposed.filter((line) => line.origin === "plan")
    .map((line) => line.id));
  const retained = existing.filter((line) => line.origin === "plan" && !next.has(line.id)
    && (line.checked || line.pinned || Boolean(line.note)));
  return { lines: [...proposed, ...retained.map((line) => ({ ...line, retained: true as const }))],
    retained };
}
