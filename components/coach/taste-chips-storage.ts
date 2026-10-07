/**
 * The local resolution `TasteChipsCard` keeps per proposal (Phase 18 W5b-2 UI, ui-taste-coach-sync):
 * split out so `components/coach/server-undo.ts` can read the SAME record without importing the
 * whole card component. Shared by both so there is exactly one reader/writer of this storage shape.
 */
import { accountKey, type AccountHandle } from "@/lib/device/account";

/** Why an applied or undone landing has nothing new to show for it (never a fresh change). */
export type AppliedNoop = "present" | "capped" | "mixed";
export type UndoneNoop = "repeat" | "gone";

/**
 * `pending`: a tap was sent (or is queued to be reused), but no success has landed yet.
 * `applied`/`undone`: the resting state once one has; `noop` names why, when there is nothing new.
 */
export type StoredTasteChips = { actionId: string; dislikes: string[]; cuisines: string[];
  status: "pending" | "applied" | "undone"; noop?: AppliedNoop | UndoneNoop };

export function tasteChipsStorageKey(h: AccountHandle, proposalId: string): string {
  return accountKey(h, `taste-chips:${proposalId}`);
}

export function readStoredTasteChips(h: AccountHandle | null, proposalId: string): StoredTasteChips | null {
  if (!h) return null;
  try {
    const raw = localStorage.getItem(tasteChipsStorageKey(h, proposalId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTasteChips>;
    if (typeof parsed.actionId !== "string" || !Array.isArray(parsed.dislikes)
      || !Array.isArray(parsed.cuisines)
      || (parsed.status !== "pending" && parsed.status !== "applied" && parsed.status !== "undone")) {
      return null;
    }
    return parsed as StoredTasteChips;
  } catch { return null; }
}

export function writeStoredTasteChips(h: AccountHandle | null, proposalId: string, value: StoredTasteChips): void {
  if (!h) return;
  try { localStorage.setItem(tasteChipsStorageKey(h, proposalId), JSON.stringify(value)); }
  catch { /* A convenience only: without storage the card may simply ask again later. */ }
}
