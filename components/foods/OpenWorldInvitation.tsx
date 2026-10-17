"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";
import { chooseFoodWorld, readFoodWorldView } from "@/lib/foods/world-open-client";
import { FOOD_WORLD_COPY } from "@/components/settings/FoodWorldSection";
import { SYNCED_EVENT } from "@/lib/sync/client";

const DISMISSED_NAME = "open-world-invite-dismissed";

/**
 * The dismissible open-world invitation (Phase 18 W13, D14), shown on Foods only while the server
 * says this account is eligible. A held account, an open one, an unreleased open world and a failed
 * read all render nothing. "Not now" is remembered on this device; Settings keeps the switch.
 */
export default function OpenWorldInvitation() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const h = currentAccountOrNull();
    if (!h || readAccountItem(h, DISMISSED_NAME) === "1") return;
    void readFoodWorldView(h).then((view) => {
      if (live && isCurrent(h) && view && view.world === "closed" && view.eligible) setShow(true);
    });
    return () => { live = false; };
  }, []);

  if (!show) return null;

  async function accept() {
    const h = currentAccountOrNull();
    if (!h || busy) return;
    setBusy(true); setMessage(null);
    const result = await chooseFoodWorld(h, "open");
    setBusy(false);
    if (!isCurrent(h)) return;
    if (result.ok) {
      setShow(false);
      window.dispatchEvent(new Event(SYNCED_EVENT));
    } else {
      setMessage(result.reason === "condition_review" ? FOOD_WORLD_COPY.review
        : result.reason === "unavailable" ? FOOD_WORLD_COPY.unavailable : FOOD_WORLD_COPY.retry);
    }
  }

  function dismiss() {
    const h = currentAccountOrNull();
    if (h) writeAccountItem(h, DISMISSED_NAME, "1");
    setShow(false);
  }

  return (
    <section aria-label="Open food list" className="flex flex-col gap-3 rounded-2xl p-4 olive-panel">
      <h2 className="font-display m-0 text-heading-sm leading-heading-sm text-charcoal">See more food ideas</h2>
      <p className="m-0 text-caption text-charcoal">
        Your Favored foods rank first and anything on Avoid stays out. The open food list adds more
        foods to your day. You can turn it off in Settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => { void accept(); }}>Turn on open food list</Button>
        <Button variant="tertiary" disabled={busy} onClick={dismiss}>Not now</Button>
      </div>
      {message && <Notice tone="attention" title={message} />}
    </section>
  );
}
