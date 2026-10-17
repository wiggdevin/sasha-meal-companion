"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { chooseFoodWorld, readFoodWorldView, type FoodWorldView } from "@/lib/foods/world-open-client";
import { SYNCED_EVENT } from "@/lib/sync/client";
import Card from "./Card";
import SettingsSection from "./Section";
import { CAPTION, CARD_TITLE } from "./settings-styles";

export const FOOD_WORLD_COPY = {
  title: "Food ideas",
  on: "Open food list is on. Ideas draw on more foods, and your Favored foods rank first. Anything on Avoid stays out.",
  off: "Ideas come only from your Favored foods. Turn on the open food list to see more variety. Your Favored foods rank first and anything on Avoid stays out.",
  review: "Your health conditions need a review before the open food list can turn on.",
  unavailable: "The open food list is not available for this account.",
  retry: "That did not save. Try again.",
} as const;

/**
 * Settings › Food ideas (Phase 18 W13, D14): the explicit open / closed switch. Hidden unless the
 * account is already open (so it can be switched back) or the server says it may be invited
 * (`/api/foods/world/invitation`); a held account, an unreleased open world and a failed read all
 * show nothing. The wire name stays `eats`; people read "Favored".
 */
export default function FoodWorldSection() {
  const [view, setView] = useState<FoodWorldView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      const h = currentAccountOrNull();
      if (!h) return;
      void readFoodWorldView(h).then((next) => { if (live && isCurrent(h)) setView(next); });
    };
    load();
    window.addEventListener(SYNCED_EVENT, load);
    return () => { live = false; window.removeEventListener(SYNCED_EVENT, load); };
  }, []);

  if (!view || (view.world === "closed" && !view.eligible)) return null;
  const open = view.world === "open";

  async function toggle() {
    const h = currentAccountOrNull();
    if (!h || busy) return;
    setBusy(true); setMessage(null);
    const result = await chooseFoodWorld(h, open ? "closed" : "open");
    if (!isCurrent(h)) return;
    setBusy(false);
    if (result.ok) {
      setView({ world: result.world, eligible: view?.eligible ?? true });
      window.dispatchEvent(new Event(SYNCED_EVENT));
    } else {
      setMessage(result.reason === "condition_review" ? FOOD_WORLD_COPY.review
        : result.reason === "unavailable" ? FOOD_WORLD_COPY.unavailable : FOOD_WORLD_COPY.retry);
    }
  }

  return (
    <SettingsSection title={FOOD_WORLD_COPY.title}>
      <Card>
        <div className="flex flex-col gap-1">
          <h3 className={`m-0 ${CARD_TITLE}`}>Open food list</h3>
          <p className={`m-0 ${CAPTION}`}>{open ? FOOD_WORLD_COPY.on : FOOD_WORLD_COPY.off}</p>
        </div>
        <Button variant="secondary" role="switch" aria-checked={open} disabled={busy}
          onClick={() => { void toggle(); }}>
          {open ? "Turn off open food list" : "Turn on open food list"}
        </Button>
        {message && <Notice tone="attention" title={message} />}
      </Card>
    </SettingsSection>
  );
}
