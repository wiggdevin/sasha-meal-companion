/** The v1 block kinds whose malformed saved payloads may be named in diagnostics. */
export const BLOCK_KINDS = [
  "log_draft", "chart", "quick_replies", "food_search", "food_ideas", "recipe_results", "ui",
  "dietary_profile_proposal", "next_action_chip",
] as const;

export function invalidV1Identity(block: unknown): { kind: string; id: string } | null {
  if (!block || typeof block !== "object") return null;
  const value = block as Record<string, unknown>;
  return typeof value.kind === "string" && BLOCK_KINDS.some((kind) => kind === value.kind)
    && value.v === 1 && typeof value.id === "string"
    ? { kind: value.kind, id: value.id }
    : null;
}
