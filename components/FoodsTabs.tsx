"use client";

import { accountHandle } from "@/lib/device/account";
import { useEffect, useState } from "react";
import AvoidsView from "@/components/AvoidsView";
import EatsView from "@/components/EatsView";
import ShoppingRoot from "@/components/ShoppingRoot";
import Segmented, { tabId } from "@/components/Segmented";
import { backfillFoodPrefs } from "@/lib/foods/prefs-client";
import { loadStore } from "@/lib/store";
import { useRecipeAccess } from "@/lib/recipe-access-client";

/**
 * The Foods tab, in two halves. One control switches the whole page: Eats is what the user can eat,
 * Avoids is what the user cannot. Before this, every rule sat under both states of a toggle that only
 * filtered their own list, so the avoid rules and the protein swaps read twice (2026-09-16).
 *
 * The tab itself has no URL state — it is one tap back, and a shared link to "the Avoids tab" is
 * not a thing the user does. `#recipes` is the exception, because three places link to it: the
 * favorites strip, the log sheet, and the old `/recipes` route. A hash link from a page that is
 * already `/foods` is a same-document navigation, so nothing remounts and the browser will not
 * scroll to a section that the Avoids tab is not rendering. Hence: read the hash, switch to the
 * tab that owns it, and scroll once that tab's panel is on screen.
 */

const PANEL_ID = "panel-foods";

type FoodsTab = "eats" | "avoids" | "shopping";

const TABS: { value: FoodsTab; label: string }[] = [
  { value: "eats", label: "Favorites" },
  { value: "avoids", label: "Avoids" },
  { value: "shopping", label: "Shopping" },
];

/** Which tab owns a hash target, or `null` to leave the tab where the user put it. */
export function tabForHash(hash: string): FoodsTab | null {
  if (hash === "#recipes" || hash === "#eats" || hash === "#discover-recipes") return "eats";
  if (hash === "#shopping") return "shopping";
  return hash === "#avoids" ? "avoids" : null;
}

export default function FoodsTabs() {
  const [tab, setTab] = useState<FoodsTab>("eats");
  const recipeAccess = useRecipeAccess();
  const shopping = recipeAccess.enabled;
  const activeTab = tab === "shopping" && !shopping ? "eats" : tab;

  /**
   * The one-shot backfill for a device whose foods pre-date the op (the 2026-09-11 legacy rows and
   * everything added since). 20 foods a mount, so a 53-food store is caught up in three visits;
   * once every food is in the ref cache the run makes no network call at all.
   */
  useEffect(() => {
    // Taken at mount: the backfill runs for the account this screen was rendered for.
    void backfillFoodPrefs(accountHandle(), loadStore().foods).catch(() => undefined);
  }, []);

  useEffect(() => {
    const follow = () => {
      const next = tabForHash(window.location.hash);
      if (next) setTab(next);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  // Separate from the effect above: the section only exists once the tab that owns it has
  // rendered, so the scroll waits for the panel, not for the hash.
  useEffect(() => {
    if (tabForHash(window.location.hash) !== activeTab) return;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [activeTab]);

  return (
    <>
      {/* Wraps under the title on a phone: three segments overflowed the row (2026-10-02). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3 px-1">
        <h1 className="ground m-0 text-display-md font-light leading-none tracking-display-md">
          Foods
        </h1>
        <Segmented label="Foods" options={shopping ? TABS : [
          { value: "eats", label: "Eats" }, { value: "avoids", label: "Avoids" },
        ]}
          value={activeTab} onChange={setTab} panel={PANEL_ID} />
      </div>
      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={tabId(activeTab)}
        className="flex flex-col gap-5"
      >
        {activeTab === "eats" ? <EatsView recipeAccess={recipeAccess} />
          : activeTab === "avoids" ? <AvoidsView /> : <ShoppingRoot />}
      </div>
    </>
  );
}
