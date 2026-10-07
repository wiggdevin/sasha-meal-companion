"use client";

import { useEffect, useState } from "react";
import type { ProposeResponse } from "@/lib/capture/types";
import { getRevision, type CachedPortion, type CachedRevision } from "@/lib/db/catalog-cache";
import { getFoodDetail, toCachedRevision } from "@/lib/catalog-client";
import { assertCurrent, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { browserClient } from "@/lib/supabase/client";

/** Fresh capture drafts may name a revision this phone has never cached. */
async function captureRevision(id: number, account: AccountHandle): Promise<CachedRevision | undefined> {
  const cached = await getRevision(id, account).catch(() => undefined);
  if (cached) return cached;
  const { data } = await withAccount(account, () => browserClient().from("catalog_food_revisions")
    .select("catalog_food_id").eq("id", id).maybeSingle());
  const catalogFoodId = (data as { catalog_food_id: number } | null)?.catalog_food_id;
  if (!catalogFoodId) return undefined;
  const result = await getFoodDetail(catalogFoodId, { revisionId: id, account });
  if (result.kind === "cached") return result.revision;
  return result.kind === "ok" && result.detail.revisionId === id
    ? toCachedRevision(result.detail) : undefined;
}

export function useCaptureRevisions(draft: ProposeResponse | null): {
  portions: Record<number, CachedPortion[]>; revisions: Record<number, CachedRevision>;
  alternativeRevisions: Record<string, CachedRevision>;
} {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [loaded, setLoaded] = useState<{
    account: AccountHandle; draft: ProposeResponse;
    portions: Record<number, CachedPortion[]>; revisions: Record<number, CachedRevision>;
    alternativeRevisions: Record<string, CachedRevision>;
  } | null>(null);
  useEffect(() => {
    const offGone = onAccountGone(() => setAccount(null));
    const offReady = onAccountReady((ready) => setAccount(ready));
    return () => { offGone(); offReady(); };
  }, []);
  useEffect(() => {
    let live = true;
    if (!draft || !account) return () => { live = false; };
    void (async () => {
      const found: Record<number, CachedPortion[]> = {};
      const loaded: Record<number, CachedRevision> = {};
      const alternatives: Record<string, CachedRevision> = {};
      for (const item of draft.items) {
        if (item.catalogFoodRevisionId !== null) {
          const revision = await captureRevision(item.catalogFoodRevisionId, account).catch(() => undefined);
          if (revision?.revision_id === item.catalogFoodRevisionId) {
            loaded[item.seq] = revision;
            const usable = revision.portions.filter((portion) =>
              Number.isFinite(portion.gramWeight) && portion.gramWeight > 0);
            if (usable.length > 0) found[item.seq] = usable;
          }
        }
        await Promise.all(item.alternatives.map(async (choice) => {
          if (!choice.catalogFoodRevisionId) return;
          const revision = await captureRevision(choice.catalogFoodRevisionId, account)
            .catch(() => undefined);
          if (revision?.revision_id === choice.catalogFoodRevisionId) {
            alternatives[choice.foodRefId] = revision;
          }
        }));
      }
      if (live) {
        try { assertCurrent(account); }
        catch { return; }
        setLoaded({ account, draft, portions: found, revisions: loaded,
          alternativeRevisions: alternatives });
      }
    })();
    return () => { live = false; };
  }, [draft, account]);
  const current = currentAccountOrNull();
  if (!account || !current || !loaded || loaded.draft !== draft
    || loaded.account.epoch !== account.epoch || account.epoch !== current.epoch
    || account.userId !== current.userId) {
    return { portions: {}, revisions: {}, alternativeRevisions: {} };
  }
  return { portions: loaded.portions, revisions: loaded.revisions,
    alternativeRevisions: loaded.alternativeRevisions };
}
