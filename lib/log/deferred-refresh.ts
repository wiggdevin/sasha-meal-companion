/**
 * A deferred log the server refused for a stale catalog revision (t17 round 3, GPT-6 BLOCK 3)
 * cannot be fixed by sending it again: the stored pick still pins the old revision. Before a retry,
 * each catalog pick is re-pinned to the CURRENT revision of the same catalog food, at the same
 * grams — the mass the user logged is the fact; the numbers per 100 g are what moved.
 *
 * Its own module so lib/log/picked-deferred.ts stays small. Nothing here sends anything.
 */
import type { AccountHandle } from "@/lib/device/account";
import { rethrowAccountChanged } from "@/lib/device/account";
import { getFoodDetail, toCachedRevision } from "@/lib/catalog-client";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { catalogCard } from "@/lib/log/catalog-card";
import type { LogPick } from "@/lib/log/picked-commit";

/**
 * The current revision of a catalog food: a revision, `gone` when the catalog no longer has the
 * food, or `offline` when it cannot be asked right now. Injected in tests.
 */
export type CurrentRevision = (
  catalogFoodId: number, h: AccountHandle,
) => Promise<CachedRevision | "gone" | "offline">;

export const currentRevisionOnline: CurrentRevision = async (catalogFoodId, h) => {
  try {
    const detail = await getFoodDetail(catalogFoodId, { account: h });
    if (detail.kind === "ok") return toCachedRevision(detail.detail);
    if (detail.kind === "not_found") return "gone";
    return "offline";
  } catch (e) {
    rethrowAccountChanged(e);
    return "offline";
  }
};

export type Refreshed =
  | { status: "ok"; picks: LogPick[]; changed: boolean }
  | { status: "gone"; name: string }
  | { status: "offline" };

type CatalogPick = Extract<LogPick, { source: "catalog" }>;

/** The pick re-pinned to `revision`, at the grams it was logged at. */
function repinned(pick: CatalogPick, revision: CachedRevision): CatalogPick {
  // A portion carries over only when the new revision has one with the same words AND the same
  // weight (t17 round 4): "1 cup" that now weighs 120 g is not the 100 g cup the user logged. With no
  // such match the line is stated in grams, which it always carried. Its mass never changes.
  const old = pick.revision.portions.find((p) => p.id === pick.portionId);
  const portion = old ? revision.portions.find((p) => p.description === old.description
    && Math.abs(p.gramWeight - old.gramWeight) < 1e-9) : undefined;
  const qty = portion ? pick.qty : pick.grams;
  const card = catalogCard({ revision, entryId: pick.card.id, itemId: pick.itemId,
    foodRefId: pick.foodRefId ?? `local:${pick.card.foodId}`, grams: pick.grams, qty,
    portion: portion ?? null, at: new Date(pick.card.at), flags: pick.card.flags });
  return { ...pick, revision, card, qty, unit: portion ? "portion" : "g",
    portionId: portion?.id ?? null };
}

/** Every catalog pick at its food's current revision. Other picks are unchanged. */
export async function refreshCatalogPicks(
  picks: LogPick[], h: AccountHandle, current: CurrentRevision = currentRevisionOnline,
): Promise<Refreshed> {
  const out: LogPick[] = [];
  let changed = false;
  for (const pick of picks) {
    if (pick.source !== "catalog") { out.push(pick); continue; }
    const now = await current(pick.revision.catalog_food_id, h);
    if (now === "offline") return { status: "offline" };
    if (now === "gone") return { status: "gone", name: pick.card.name };
    if (now.revision_id === pick.revision.revision_id) { out.push(pick); continue; }
    changed = true;
    out.push(repinned(pick, now));
  }
  return { status: "ok", picks: out, changed };
}
