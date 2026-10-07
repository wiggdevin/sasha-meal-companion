import { CUISINE_LABELS, type CuisineKey } from "@/lib/profile/cuisines";
import type { CoachUndoCard } from "@/lib/coach/undo-types";

/**
 * A record the server holds and this phone has no token for (components/coach/server-undo.ts),
 * drawn from the record's card only: a receipt's title and foods, or "Coach change" and when the
 * server recorded it (docs/specs/coach-undo-receipt.md §6.5). Never from a coach action.
 */
export type ServerCard = { card: CoachUndoCard; createdAt: string };

/** When the server recorded a change, for a generic card: "Mon 5 Oct, 12:00" in this phone's zone. */
export function changeTime(createdAt: string): string | null {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit" }).format(at);
}

/** A stored dislike key ("f:mushroom", "t:spicy") read as a short label; never implies exclusion. */
function dislikeLabel(key: string): string {
  return key.startsWith("t:") || key.startsWith("f:") ? key.slice(2) : key;
}

function cuisineLabel(key: string): string {
  return (CUISINE_LABELS as Record<string, string>)[key as CuisineKey] ?? key;
}

/** A server-held card's lines: a receipt's foods; a taste card's added chips; a generic card's time. */
export function serverLines(server: ServerCard): { name: string; grams: number | null }[] {
  if (server.card.type === "receipt") {
    return server.card.lines.map((line) => ({ name: line.name ?? "Unnamed food", grams: line.grams }));
  }
  if (server.card.type === "taste") {
    const labels = [...server.card.added.dislikes.map(dislikeLabel), ...server.card.added.cuisines.map(cuisineLabel)];
    if (labels.length > 0) return labels.map((name) => ({ name, grams: null }));
    const time = changeTime(server.createdAt);
    return time ? [{ name: time, grams: null }] : [];
  }
  const time = changeTime(server.createdAt);
  return time ? [{ name: time, grams: null }] : [];
}
