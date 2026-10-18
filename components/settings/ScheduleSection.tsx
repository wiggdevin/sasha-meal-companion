"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { useButtonStatus } from "@/components/ui/useButtonStatus";
import { ICS_FILENAME, generateMealPlanIcs, icsBlob, icsDataUri } from "@/lib/ics";
import type { SlotId } from "@/lib/types";
import SettingsSection from "./Section";
import { CAPTION, CARD_TITLE, ROW_TITLE } from "./settings-styles";
import { APP_CALENDAR_NAME } from "@/lib/brand";
import { mealCountFor, slotListFor } from "@/lib/plan";
import type { Settings } from "@/lib/types";

const SHIFT_STEP = 15;
/** The share sheet's title, matching the calendar's own `X-WR-CALNAME` (`lib/ics.ts`). */
const ICS_CALENDAR_NAME = APP_CALENDAR_NAME;
type Layout = Pick<Settings, "mealsPerDay" | "activeTargetProfile">;

function shiftLabel(minutes: number): string {
  if (minutes === 0) return "On schedule";
  return `${Math.abs(minutes)} minutes ${minutes < 0 ? "earlier" : "later"}`;
}

/**
 * The meal-times card: the whole-day shift, each meal's own time, and the calendar export as its
 * last row (U17, 2026-10-04: "Calendar reminders" was a card of its own; the owner asked for fewer,
 * fuller cards, none longer than Body profile & units).
 */
function ShiftControls({ shiftMinutes, slotTimes, layout, onShiftChange, onSlotTimeChange }: {
  shiftMinutes: number;
  slotTimes: Partial<Record<SlotId, string>>;
  layout: Layout;
  onShiftChange: (minutes: number) => void;
  onSlotTimeChange: (slot: SlotId, time: string | null) => void;
}) {
  return (
    <section className="shell" aria-label="Meal times">
      <div className="surface flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h3 id="whole-day-shift-label" className={`m-0 ${CARD_TITLE}`}>
            Shift the whole day
          </h3>
          <p className={`m-0 ${CAPTION}`}>Move every slot at once when your schedule changes.</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className={ROW_TITLE}>{shiftLabel(shiftMinutes)}</span>
          <div role="group" aria-labelledby="whole-day-shift-label"
            className="well inline-flex shrink-0 p-1">
            <div className="flex items-center">
              <button type="button" aria-label="Shift the day earlier"
                onClick={() => onShiftChange(shiftMinutes - SHIFT_STEP)}
                className="tap flex min-h-11 min-w-11 items-center justify-center text-heading-sm">−</button>
              <button type="button" aria-label="Shift the day later"
                onClick={() => onShiftChange(shiftMinutes + SHIFT_STEP)}
                className="tap flex min-h-11 min-w-11 items-center justify-center text-heading-sm">+</button>
            </div>
          </div>
        </div>
        {shiftMinutes !== 0 && (
          <Button variant="ghost" size="sm" onClick={() => onShiftChange(0)} className="-ml-3 self-start">
            Reset to on schedule
          </Button>
        )}
        <div className="flex flex-col gap-1 pt-2">
          <h3 className={`m-0 ${ROW_TITLE}`}>One slot&rsquo;s own time</h3>
          <p className={`m-0 ${CAPTION}`}>Applied after your whole-day shift.</p>
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {slotListFor("rest", layout).map((id, index, slots) => {
            const label = `Meal ${index + 1}`;
            return (
              <li key={id} className={`flex items-center justify-between gap-3 py-2 ${
                index === slots.length - 1 ? "" : "border-b border-hairline"}`}>
                <label htmlFor={`slot-time-${id}`} className={`min-w-0 flex-1 ${ROW_TITLE}`}>
                  {label}
                </label>
                <div className="flex shrink-0 items-center gap-2">
                  <input id={`slot-time-${id}`} type="time" aria-label={`${label} time`}
                    value={slotTimes[id] ?? ""}
                    onChange={(event) => onSlotTimeChange(id, event.target.value || null)}
                    className="well tap min-h-11 px-3 text-caption text-charcoal" />
                  {slotTimes[id] && (
                    <Button variant="ghost" size="sm" aria-label={`Clear ${label} override`}
                      onClick={() => onSlotTimeChange(id, null)}>Clear</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <CalendarRow shiftMinutes={shiftMinutes} slotTimes={slotTimes} layout={layout} />
      </div>
    </section>
  );
}

function isShareCancel(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Calendar reminders, the meal-times card's last row: share or download the meal times as a calendar. */
function CalendarRow({ shiftMinutes, slotTimes, layout }: {
  shiftMinutes: number; slotTimes: Partial<Record<SlotId, string>>;
  layout: Layout;
}) {
  const [status, setStatus] = useState<"idle" | "shared" | "downloaded">("idle");
  const button = useButtonStatus();
  async function addToCalendar(): Promise<void> {
    const calendar = generateMealPlanIcs({ shiftMinutes, slotTimes, ...layout });
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        const file = new File([icsBlob(calendar)], ICS_FILENAME, { type: "text/calendar" });
        if (typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: ICS_CALENDAR_NAME });
          setStatus("shared");
          return;
        }
      }
    } catch (error) {
      // Backing out of the share sheet is a choice, not a failure: nothing downloads (UI audit
      // 2026-10-18 §3). Any other share error continues to the direct calendar download.
      if (isShareCancel(error)) throw error;
    }
    window.location.href = icsDataUri(calendar);
    setStatus("downloaded");
  }
  return (
    <div className="flex flex-col gap-1 border-t border-hairline pt-4">
      {/* One line where it fits, the button wrapping under the title where it does not (320 px). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className={`m-0 ${ROW_TITLE}`}>Calendar reminders</h3>
        <Button variant="secondary" size="sm" status={button.status}
          confirmLabel={status === "shared" ? "Shared" : "Downloaded"}
          onClick={() => void button.run(addToCalendar).then((result) => {
            // A dismissed share sheet leaves the button as it was, with no "Downloaded".
            if (!result.ok && isShareCancel(result.error)) button.reset();
          })}>
          Add to Calendar
        </Button>
      </div>
      <p className={`m-0 ${CAPTION}`}>
        {status === "idle"
          ? "Add your meal times to your calendar so reminders work when the app is closed."
          : `${status === "shared" ? "Shared" : "Downloaded"}. Open it and tap Add All.`}
      </p>
    </div>
  );
}

export default function ScheduleSection({
  shiftMinutes,
  slotTimes,
  mealsPerDay,
  activeTargetProfile,
  onMealsPerDayChange,
  onShiftChange,
  onSlotTimeChange,
}: {
  shiftMinutes: number;
  slotTimes: Partial<Record<SlotId, string>>;
  mealsPerDay?: number | null;
  activeTargetProfile?: Settings["activeTargetProfile"];
  onMealsPerDayChange?: (count: number) => void;
  onShiftChange: (minutes: number) => void;
  onSlotTimeChange: (slot: SlotId, time: string | null) => void;
}) {
  const layout = { mealsPerDay, activeTargetProfile };
  const count = mealCountFor(layout);
  return (
    <SettingsSection title="Schedule & reminders">
      <section className="shell" aria-label="Meals per day">
        <div className="surface flex items-center justify-between gap-4 p-4">
          <div><h3 className={`m-0 ${ROW_TITLE}`}>Meals per day</h3>
            <p className={`m-0 ${CAPTION}`}>Choose what fits your day.</p></div>
          <div role="group" aria-label="Meals per day" className="well inline-flex items-center p-1">
            <button type="button" aria-label="Fewer meals" disabled={count <= 2}
              onClick={() => onMealsPerDayChange?.(count - 1)} className="tap min-h-11 min-w-11 disabled:opacity-40">−</button>
            <output aria-live="polite" className="min-w-6 text-center">{count}</output>
            <button type="button" aria-label="More meals" disabled={count >= 6}
              onClick={() => onMealsPerDayChange?.(count + 1)} className="tap min-h-11 min-w-11 disabled:opacity-40">+</button>
          </div>
        </div>
      </section>
      <ShiftControls shiftMinutes={shiftMinutes} slotTimes={slotTimes} layout={layout}
        onShiftChange={onShiftChange} onSlotTimeChange={onSlotTimeChange} />
    </SettingsSection>
  );
}
