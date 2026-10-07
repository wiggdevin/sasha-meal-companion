"use client";

import { useState } from "react";
import { ICS_FILENAME, generateMealPlanIcs, icsBlob, icsDataUri } from "@/lib/ics";
import type { SlotId } from "@/lib/types";
import { APP_CALENDAR_NAME } from "@/lib/brand";

/**
 * Calendar reminders, PRD §7/acceptance criterion 7. No backend (PRD §4), so
 * reminders ride on a regenerated .ics your iOS Calendar app subscribes to —
 * see lib/ics.ts's own header comment for why.
 *
 * Regenerating correctly after a shift is just: always build the .ics from
 * the CURRENT `shiftMinutes`/`slotTimes` props at click time, never from a
 * cached file. The parent (Settings page) re-renders this with fresh
 * settings on every change, so there is nothing to invalidate.
 */
type IcsSubscribeProps = {
  shiftMinutes: number;
  slotTimes: Partial<Record<SlotId, string>>;
};

type Status = "idle" | "shared" | "downloaded";

/* Recipes copied verbatim: CARD_TITLE / CAPTION from EatsReference.tsx,
   INK_BUTTON from LogFoodSheet.tsx (DESIGN.md Buttons > Primary (ink)). */
const CARD_TITLE = "text-title";
const CAPTION = "text-tiny font-normal text-muted";
const BODY = "text-caption font-normal leading-[1.7] text-graphite";
// .btn-ink (app/globals.css, unlayered) sets font-size/font-weight, which beats a plain Tailwind
// utility (layered) — the `!` modifier keeps this button at the inline style's old 16px/400 rather
// than falling back to btn-ink's 14px/500.
const INK_BUTTON_CLASS = "h-[52px] text-body! font-normal!";
const INK_BUTTON_SHADOW_STYLE: React.CSSProperties = { boxShadow: "var(--shadow-button)" };

export default function IcsSubscribe({ shiftMinutes, slotTimes }: IcsSubscribeProps) {
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubscribe() {
    const ics = generateMealPlanIcs({ shiftMinutes, slotTimes });

    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        const file = new File([icsBlob(ics)], ICS_FILENAME, { type: "text/calendar" });
        const canShareFile =
          typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] });
        if (canShareFile) {
          await navigator.share({ files: [file], title: APP_CALENDAR_NAME });
          setStatus("shared");
          return;
        }
      }
    } catch {
      // Share sheet cancelled or unsupported for files — fall through to a
      // direct download/subscribe link instead.
    }

    if (typeof window !== "undefined") {
      window.location.href = icsDataUri(ics);
      setStatus("downloaded");
    }
  }

  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <h2 className={`m-0 ${CARD_TITLE}`}>
          Calendar reminders
        </h2>
        <p className={`m-0 ${BODY}`}>
          Adds every meal time to your iPhone Calendar, so reminders fire even with the app
          closed. Subscribe once — it always reflects the times above.
        </p>
        <button
          type="button"
          onClick={handleSubscribe}
          className={`btn-ink tap mt-1 w-full px-5 ${INK_BUTTON_CLASS}`}
          style={INK_BUTTON_SHADOW_STYLE}
        >
          Add to Calendar
        </button>
        {status === "shared" && (
          <p className={`m-0 ${CAPTION}`}>
            Shared — open it and tap Add All to save the reminders.
          </p>
        )}
        {status === "downloaded" && (
          <p className={`m-0 ${CAPTION}`}>
            Downloaded — open the file and tap Add All to save the reminders.
          </p>
        )}
      </div>
    </section>
  );
}
