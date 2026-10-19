"use client";

/**
 * The Ingredients deck's order (UI makeover §7.3): `POST /api/shopping/build/rank` with the
 * candidates' ids and names only (no budget, place, health or profile field). The answer may only
 * reorder: an id the deck did not send is ignored, a sent id the answer left out keeps its place
 * after the ranked ones, so the deck never gains or loses a card here. Any failure (offline, the
 * `rank` deadline, a non-2xx, a malformed body, an account switch) is the plain order with
 * `{ ai: false, source: "app" }`, and the deck says "In your usual order".
 */
import { accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import type { Provenance } from "@/lib/types";

export const RANK_PURPOSE = "shopping-build-rank";
const APP: Provenance = { ai: false, source: "app" };

export type RankedDeck<T extends { id: string }> = { items: T[]; provenance: Provenance };

/** Pure: `items` reordered by `order`, never adding or dropping one. */
export function applyRankOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  for (const item of items) if (!seen.has(item.id)) out.push(item);
  return out;
}

function validProvenance(value: unknown): Provenance | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.ai === true && row.source === "jev" && row.purpose === RANK_PURPOSE) {
    return { ai: true, source: "jev", purpose: RANK_PURPOSE };
  }
  if (row.ai === false && row.source === "app") return APP;
  return null;
}

export async function rankCandidates<T extends { id: string; name: string }>(
  items: readonly T[], opts: { account?: AccountHandle; fetchImpl?: typeof fetch } = {},
): Promise<RankedDeck<T>> {
  const plain = { items: [...items], provenance: APP };
  if (items.length === 0 || items.length > 30) return plain;
  try {
    const account = opts.account ?? accountHandle();
    const res = await accountFetch(account, "/api/shopping/build/rank", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: items.map(({ id, name }) => ({ id, name })) }),
    }, { budget: "rank", fetchImpl: opts.fetchImpl });
    if (!res.ok) return plain;
    const body = await accountJson<unknown>(account, res);
    if (typeof body !== "object" || body === null) return plain;
    const { order, provenance } = body as { order?: unknown; provenance?: unknown };
    const stamp = validProvenance(provenance);
    if (!stamp || !Array.isArray(order) || !order.every((id) => typeof id === "string")) return plain;
    // The app's own order carries no AI label, whatever the list looks like.
    if (!stamp.ai) return plain;
    return { items: applyRankOrder(items, order as string[]), provenance: stamp };
  } catch {
    return plain;
  }
}
