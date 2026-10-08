"use client";

import { useEffect, useRef, useState } from "react";
import { currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import TourLayer, { type TourOpening } from "@/components/tour/TourLayer";
import { TOUR_OPEN_EVENT, type TourOpenDetail } from "@/components/tour/tour-events";
import { markTourSeen, readTourSeen, shouldAutoOpenTour } from "@/components/tour/tour-seen";

/** Today paints first; the overview follows a moment later so it reads as arriving, not blocking. */
export const AUTO_OPEN_DELAY_MS = 700;

/**
 * Today's overview host. It opens by itself once per account on this device, on the first Today
 * visit after onboarding is complete, and again whenever the companion in the well is tapped
 * (`requestTour`). The "seen" mark is written the moment it opens, on the phone only, so closing it
 * works offline and a crash never brings it back in a loop. Any failure reading or drawing it simply
 * skips it.
 */
export default function TodayTour({ onboardedAt }: { onboardedAt: string | null | undefined }) {
  const [account] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [opening, setOpening] = useState<TourOpening | null>(null);
  const seq = useRef(0);
  const auto = useRef(false);

  useEffect(() => {
    if (!account || auto.current) return;
    if (!shouldAutoOpenTour({ onboardedAt, seen: readTourSeen(account) })) return;
    auto.current = true;
    const timer = setTimeout(() => {
      markTourSeen(account);
      setOpening((open) => open ?? { origin: null, returnFocusTo: null, seq: ++seq.current });
    }, AUTO_OPEN_DELAY_MS);
    return () => { clearTimeout(timer); auto.current = false; };
  }, [account, onboardedAt]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const origin = (event as CustomEvent<TourOpenDetail>).detail?.origin ?? null;
      if (account) markTourSeen(account);
      setOpening({
        origin: origin?.getBoundingClientRect() ?? null,
        returnFocusTo: origin instanceof HTMLElement ? origin : null,
        seq: ++seq.current,
      });
    };
    window.addEventListener(TOUR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(TOUR_OPEN_EVENT, onOpen);
  }, [account]);

  return <TourLayer opening={opening} onClose={() => {
    if (account) markTourSeen(account);
    setOpening(null);
  }} />;
}
