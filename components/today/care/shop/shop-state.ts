import { itemById, type LedgerRow, type Slot } from "@/components/today/care/shop/catalog";

/**
 * The shop's rules, as pure functions, shaped like the server contract asked for in UI-NEEDS
 * SPROUT-CARE (`POST /api/care/purchase { itemId, actionId }`, `POST /api/care/equip { slot, itemId }`)
 * so the gallery's samples and the real routes behave alike. A purchase debits and grants at once and
 * is idempotent on its action id (a retry answers the first receipt); the balance never goes below
 * zero; only an owned item can be worn, and only in its own slot.
 */

export type Receipt = { actionId: string; itemId: string; price: number; balance: number };

export type ShopState = {
  balance: number;
  owned: readonly string[];
  equipped: Readonly<Partial<Record<Slot, string>>>;
  /** Moves on every equipment change (the server's `rev`). */
  rev: number;
  receipts: Readonly<Record<string, Receipt>>;
  ledger: readonly LedgerRow[];
};

export type PurchaseOutcome =
  | { ok: true; state: ShopState; receipt: Receipt; replay: boolean }
  | { ok: false; code: "unknown_item" | "owned" | "action_conflict" }
  | { ok: false; code: "insufficient"; short: number };

export function purchase(state: ShopState, itemId: string, actionId: string, localDate: string): PurchaseOutcome {
  const prior = state.receipts[actionId];
  if (prior) return prior.itemId === itemId ? { ok: true, state, receipt: prior, replay: true } : { ok: false, code: "action_conflict" };
  const item = itemById(itemId);
  if (!item) return { ok: false, code: "unknown_item" };
  if (state.owned.includes(itemId)) return { ok: false, code: "owned" };
  if (state.balance < item.price) return { ok: false, code: "insufficient", short: item.price - state.balance };
  const receipt: Receipt = { actionId, itemId, price: item.price, balance: state.balance - item.price };
  const row: LedgerRow = { id: `buy-${actionId}`, kind: "purchase", delta: -item.price, localDate, status: "settled", itemId };
  return {
    ok: true,
    replay: false,
    receipt,
    state: { ...state, balance: receipt.balance, owned: [...state.owned, itemId],
      receipts: { ...state.receipts, [actionId]: receipt }, ledger: [row, ...state.ledger] },
  };
}

export type EquipOutcome = { ok: true; state: ShopState } | { ok: false; code: "not_owned" | "wrong_slot" | "not_wearable" };

/** Wears an owned item in its slot, or clears the slot with `null`. */
export function equip(state: ShopState, slot: Slot, itemId: string | null): EquipOutcome {
  if (itemId === null) {
    if (!state.equipped[slot]) return { ok: true, state };
    const equipped = { ...state.equipped };
    delete equipped[slot];
    return { ok: true, state: { ...state, equipped, rev: state.rev + 1 } };
  }
  const item = itemById(itemId);
  if (!item || !state.owned.includes(itemId)) return { ok: false, code: "not_owned" };
  // A care scene is done for Sprout, never worn.
  if (item.slot === "care" || slot === "care") return { ok: false, code: "not_wearable" };
  if (item.slot !== slot) return { ok: false, code: "wrong_slot" };
  if (state.equipped[slot] === itemId) return { ok: true, state };
  return { ok: true, state: { ...state, equipped: { ...state.equipped, [slot]: itemId }, rev: state.rev + 1 } };
}

/** Seeds still pending (daily awards settle after the account's day closes). */
export const pendingSeeds = (state: ShopState): number =>
  state.ledger.reduce((sum, row) => (row.status === "pending" ? sum + row.delta : sum), 0);

/** "42 Seeds", "1 Seed". */
export const seeds = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "Seed" : "Seeds"}`;
