/**
 * Is a mirrored `log_entries` row fit to base an edit on?
 *
 * A revision is not enough. The verbatim mirror stores what the server's reply carried, and a
 * reply can describe an entry's items more thinly than a row does — so a row could hold a real
 * revision beside items with no `food_ref_id`. An edit built from those is a valid-looking POST
 * that the server names invalid, and the refusal then rolls back a meal the server still holds
 * (Grok pass 3, HIGH 2).
 *
 * So the question is asked in one place, by everything that edits an entry it did not build: the
 * note path (lib/log-note-client.ts) and the coach's undo (lib/coach/apply-client.ts).
 */

/**
 * A mirror row without the client's own bookkeeping.
 *
 * `_attempt` says which commit wrote an optimistic row, so a refusal can tell its own row from one
 * another attempt landed. It is not a column, and a row that is going to be treated as the
 * server's — stored as acknowledged, or built into a payload and POSTed — must not carry it or
 * anything else prefixed `_` (Grok pass 10, HIGH 2).
 */
export function serverFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!key.startsWith("_")) out[key] = value;
  return out;
}

/** The fields an item must name for the row it is in to be worth storing under a revision. */
const ITEM_FIELDS = ["id", "food_ref_id", "seq", "grams", "unit", "snapshot"] as const;

/**
 * One stored item, whole. The same question the mirror asks of a commit reply before it takes the
 * revision beside it (lib/log-commit-settle.ts): a row that holds a real revision over items this
 * thin is a row nothing can edit from, and the edit it produces is refused (panel round 10).
 */
export function isCompleteItem(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const fields = item as Record<string, unknown>;
  return ITEM_FIELDS.every((field) => {
    // A null mass is a stored fact (t17: unknown), complete when the count says the amount.
    if (field === "grams" && fields.grams === null) {
      return typeof fields.qty === "number" && fields.qty > 0;
    }
    return fields[field] !== undefined && fields[field] !== null;
  });
}

export function isCompleteEntryRow(row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const entry = row as Record<string, unknown>;
  if (entry.deleted_at) return false;
  if (typeof entry.rev !== "number") return false;
  if (!Array.isArray(entry.items) || entry.items.length === 0) return false;
  return entry.items.every(isCompleteItem);
}
