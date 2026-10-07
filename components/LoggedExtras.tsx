"use client";

import { accountHandle } from "@/lib/device/account";
import MealTimeline from "./MealTimeline";
import styles from "./MealTimeline.module.css";
import dark from "./AfterDarkCards.module.css";
import { useMealReschedule } from "./useMealReschedule";
import { Fragment, useEffect, useState } from "react";
import { CaptureGlyph } from "@/components/CaptureSheet";
import { captureMetaFrom, type CaptureMeta } from "@/lib/capture-client";
import { entryMacros } from "@/lib/resolve";
import { illustrativeMealImage } from "@/lib/today/meal-art";
import Image from "next/image";
import { ALERT_PILL, formatTime } from "@/components/SlotCard";
import { feedbackStateProps, type ActionFeedbackPhase } from "@/components/ui/ActionFeedback";
import KcalText from "@/components/ui/KcalText";
import Button from "@/components/ui/Button";
import { getRow } from "@/lib/sync/idb";
import { PARTIAL_NOTE, eatenBound, withBound } from "@/lib/nutrition-display";
import type { Macros, LoggedFood } from "@/lib/types";
import { MEAL_TITLE } from "@/lib/design/meal-type";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Macro and calorie display, rounded the way a plan slot's macros already arrive. */
function round(n: number): string {
  return String(Math.round(n));
}

/** True once at least one item of the entry carries a measured nutrient snapshot — the same rule
 *  `NutrientBreakdown` uses to decide it has something to show. */
function hasMeasuredSnapshot(e: LoggedFood): boolean {
  return (e.items ?? []).some((i) => Object.keys(i.snapshot ?? {}).length > 0);
}

/** A logged meal (several foods in one entry) rather than a single food. */
function MealIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h16" />
      <path d="M5 12a7 7 0 0 1 14 0" />
      <path d="M3 16h18" />
    </svg>
  );
}


/** The entry's local clock time as "HH:MM" — what the timeline drags (components/useMealReschedule.ts). */
function localClock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "12:00";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" → "8:00 am", the way a plan slot's time reads. */
function clockLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** The clock time the entry was logged at, formatted like a plan slot's time. */
function loggedTime(at: string): string | null {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatTime(`${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`);
}

/**
 * The secondary label beside the logged time.
 *
 * Design §8.5: a slot value this build does not recognise — a newer server kind, or an entry with
 * no slot at all — must not borrow a label that means something else. "Snack" is the `snack` kind's
 * own name, and the old catch-all "Logged" said nothing. The fallback says what the entry actually
 * is instead: the foods in it, then its own name, then the one honest generic.
 */
export function slotLabel(entry: LoggedFood): string {
  const slot = entry.slot;
  if (slot?.startsWith("meal-")) return slot.replace("meal-", "Meal ");
  if (slot === "pouches-pre") return "Pre-training carbs";
  if (slot === "post-refuel") return "Post-training refuel";
  if (slot === "hot-chocolate") return "Hot chocolate";
  if (slot === "coffee") return "Coffee";
  if (slot === "snack") return "Snack";
  const fromItems = (entry.items ?? []).map((item) => item.name).filter(Boolean).join(" & ");
  return fromItems || entry.name || "Logged food";
}

/**
 * The amount line under an entry's name.
 *
 * Whole numbers, like the plan card above it: the two now sit in one stack, and "122.22 kcal ·
 * 0.93P" next to "537 kcal · 40P" reads as a different kind of number.
 *
 * An entry whose items exist but carry no measured snapshot has not been measured at zero — it
 * has not been measured. A capture card is written before the server answers and its nutrients
 * only arrive with the reply (T0 §3), so printing "0 kcal" there would be a number the user can
 * see and would believe. It says so in words instead, and keeps the grams it does know.
 *
 * The test is the snapshot, NOT the pending mark: a reconcile can be skipped — a diverged answer,
 * a 2xx the client could not read, an IndexedDB that would not write — and the mark then clears
 * with the numbers still missing (Grok pass 2, MEDIUM 12). An entry logged by hand, which
 * never had items in the first place, keeps its own macros and is unaffected.
 */
export function macroLine(
  e: LoggedFood, m: Macros, measured: boolean, _pending: boolean
): string {
  // Mass unknown (t17): `e.grams` is a placeholder (0), not the amount — the count and unit are,
  // the same words the unmeasured fallback below already uses for a food logged by hand.
  const amount = e.massUnknown
    ? `${fmt(e.qty)} × ${e.portionLabel}`
    : measured
      ? `${fmt(e.grams)} g`
      : e.items
        ? `${e.items.length} item${e.items.length === 1 ? "" : "s"}`
        : `${fmt(e.qty)} × ${e.portionLabel}`;
  // Items but no snapshot on any of them: the numbers are still coming from the server.
  if (!measured && (e.items?.length ?? 0) > 0) return `${amount} · kcal pending`;
  const figures = [`${round(m.kcal)} kcal`, `${round(m.protein)} PRO`, `${round(m.carbs)} CAR`, `${round(m.fat)} FAT`];
  // #21: a partly measured recipe serving is a lower bound in every figure. "at least" opens one
  // comma-joined group so it governs all four; the amount stays outside it (review: Sol).
  if (e.nutritionPartial === true) return `${amount} · ${withBound(figures.join(", "), eatenBound(true))}`;
  return [amount, ...figures].join(" · ");
}

/** Name line, macro line and note — the text column inside a row's main tap button. */
/**
 * An entry whose read-backs ran out. The server HAS it — that is what makes it different from a
 * save still in flight — this phone simply could not read the row back. Drawing the not-synced
 * mark over one of those invites a second Log and a doubled day (Grok pass 7, MEDIUM 4).
 */
export const STALE_LINE = "Logged. Details are still catching up.";

/**
 * And the one for a write NOTHING ever confirmed — the queue failed, or the page died before the
 * POST went. The user must be told to try again: for this app a meal missing from the log is worse
 * than one logged twice, and a card that says "logged" is why they would not save it again.
 */
export const UNSAVED_LINE = "Not saved yet. Tap to try again.";

/**
 * And when there is nothing left to send — the kept request was dropped at the cap — the card says
 * so plainly rather than offering a tap that would do nothing (Grok pass 10, HIGH 1).
 */
export const LOST_LINE = "Not saved. Log it again.";

/** A refused deferred log (t17, lib/log/picked-deferred.ts): `entry.notSaved` carries the specific
 *  reason, kept as the control's `title`; the visible line is this one sentence, with its retry. */
export const NOT_SAVED_LINE = "Not saved. Try again.";

function EntryText({
  e,
  m,
  measured,
  pending,
  stale,
  unsaved,
  lost,
  meta,
  previewTime,
}: {
  e: LoggedFood;
  m: Macros;
  measured: boolean;
  pending: boolean;
  stale?: boolean;
  unsaved?: boolean;
  lost?: boolean;
  meta?: CaptureMeta;
  /** While the timeline is dragged: the time under the finger, shown in place of the logged one. */
  previewTime?: string | null;
}) {
  const time = previewTime ? clockLabel(previewTime) : loggedTime(e.at);
  return (
    <>
      <span className="flex w-full flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className={`flex min-w-0 items-center gap-1.5 truncate ${MEAL_TITLE.compact}`}>
          {pending && (
            <span
              aria-label="Not synced yet"
              title="Not synced yet"
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber"
            />
          )}
          {meta ? (
            <span role="img" aria-label={`Logged by ${meta.method}`} className="shrink-0 text-muted">
              <CaptureGlyph method={meta.method} size={16} />
            </span>
          ) : e.items ? <MealIcon /> : null}
          {e.name}
        </span>
        {time && (
          <span className="shrink-0 text-tiny font-normal tabular-nums text-muted">
            {time} · {slotLabel(e)}
          </span>
        )}
      </span>
      {/* Each figure keeps its unit ("10 FAT"): the line breaks after a separator, never inside a figure. */}
      <span className="text-tiny font-normal leading-body-sm tabular-nums text-muted">
        {macroLine(e, m, measured, pending).split(" · ").map((part, index) => <Fragment key={index}>
          {index > 0 && "\u00a0· "}{part.split(", ").map((piece, at) => <Fragment key={at}>
            {at > 0 && ", "}<span className="whitespace-nowrap"><KcalText text={piece} /></span></Fragment>)}
        </Fragment>)}
        {e.flags?.length ? <span className="text-amber"> · off-plan</span> : null}
        {/* Beside off-plan, never in its place: a partial count is not a rule mark. Covers a
            partly measured recipe (#21) and an unknown mass (t17) with the same note. */}
        {(e.nutritionPartial || e.massUnknown) && (measured || !e.items?.length)
          ? <span className="text-muted" data-partial=""> · {PARTIAL_NOTE}</span> : null}
      </span>
      {stale && !pending && !unsaved && !lost && (
        <span className="text-tiny font-normal text-muted">{STALE_LINE}</span>
      )}
      {lost && !pending && (
        <span className="text-tiny font-normal text-alert">{LOST_LINE}</span>
      )}
      {meta?.lowConfidence && (
        <span className="text-tiny font-normal text-muted">Best guess. Check it.</span>
      )}
      {e.note && (
        <span className="truncate text-tiny font-normal italic text-muted">“{e.note}”</span>
      )}
    </>
  );
}

/** The Note/Add-note button, plus a Nutrients button for a measured entry (secondary, sm: actions
 *  on a card) — sibling buttons of the row's main button, never nested inside it. */
function EntryPills({
  e,
  measured,
  onOpen,
  onDetails,
}: {
  e: LoggedFood;
  measured: boolean;
  onOpen: (id: string) => void;
  onDetails?: (id: string) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {measured && onDetails && <Button size="sm" onClick={() => onDetails(e.id)}>Nutrients</Button>}
      <Button size="sm" onClick={() => onOpen(e.id)}>{e.note ? "Edit note" : "Add note"}</Button>
    </span>
  );
}

/**
 * One logged entry, as a card in the Today stack. A `<div>` shell holding sibling `<button>`s —
 * never a button inside a button — so the main tap area (open the note/entry sheet) and the
 * pill(s) (open the note sheet, or the nutrient breakdown for a Phase 2 entry) are each their own
 * target.
 *
 * Olive through and through: it sits between plan slots, and the stack already spends white on an
 * upcoming slot and charcoal on an eaten one. Green is "logged by hand".
 */
export function LoggedExtraCard({
  entry: e,
  pending,
  stale,
  unsaved,
  lost,
  onOpen,
  onDetails,
  onRetry,
  retryState,
  onTimeChange,
}: {
  entry: LoggedFood;
  pending: boolean;
  /** Written, and the server has it, but this phone has stopped trying to read the row back. */
  stale?: boolean;
  /** Written, and nothing ever saw the server take it. The user is asked to try again. */
  unsaved?: boolean;
  /** The same, with nothing left to send: the user is asked to log it again instead. */
  lost?: boolean;
  onOpen: (id: string) => void;
  onDetails?: (id: string) => void;
  onRetry?: (id: string) => void;
  /** The page's shared ActionFeedback phase for this entry's retry. */
  retryState?: ActionFeedbackPhase;
  /** A hold on the card opens the plan cards' timeline; release saves the dragged time
   *  (2026-09-18: the coach logs a snack at "now", which is not always when it was eaten). */
  onTimeChange?: (time: string) => void | Promise<void>;
}) {
  // Read here rather than in the page: Today early-returns its skeleton before `resolved` exists,
  // so a hook call up there would be a conditional one.
  const meta = useCaptureMeta(e.id)[e.id];
  const m = entryMacros(e);
  const measured = hasMeasuredSnapshot(e);
  const snackImage = e.slot === "snack" ? illustrativeMealImage(e.name, e.items ?? []) : null;
  const gesture = useMealReschedule(localClock(e.at), onTimeChange);
  const shownTime = gesture.preview ?? localClock(e.at);
  // The same card props SlotCard builds for the timeline drag; a save in flight is shared-pending.
  const pendingProps = feedbackStateProps(pending ? "pending" : undefined);
  const cardProps = {
    ref: gesture.ref,
    "data-rescheduling": gesture.preview !== null ? "true" : undefined,
    style: {
      position: "relative" as const,
      userSelect: "none" as const,
      opacity: gesture.preview !== null ? .35 : undefined,
      zIndex: gesture.preview !== null ? 20 : undefined,
    },
  };

  return (
    <div className={`meal-card block min-w-0 w-full max-w-full ${styles.card} ${e.slot === "snack" ? dark.snackTicket : ""} ${pendingProps.className}`}
      data-feedback-state={pendingProps["data-feedback-state"]} data-after-dark-snack={e.slot === "snack" ? "true" : undefined} {...cardProps}>
      {gesture.timeline && <MealTimeline position={gesture.timeline} time={shownTime} name={e.name} />}
      {(gesture.saving || gesture.error) && <span role={gesture.error ? "alert" : "status"}
        className={`pointer-events-none absolute -top-3 right-4 z-20 rounded-full px-4 py-2 text-tiny shadow-lg ${
          gesture.error ? ALERT_PILL : "bg-primary text-on-primary"}`}>
        {gesture.error ?? (gesture.saving ? "Saving time…" : `${clockLabel(shownTime)} · Release to save`)}
      </span>}
      {/* A card on the ground is E1 (DESIGN.md §Elevation): the face carries the drop, not the wrapper,
          which also holds the retry line under the card. The snack ticket brings its own. */}
      <span className={`logged-card-in items-center gap-[14px] px-[18px] py-4 ${e.slot === "snack" ? "" : "elev-1"}`}>
        {e.slot === "snack" && <span className={dark.snackArt} aria-hidden="true">
          {snackImage && <Image src={snackImage} alt="" fill sizes="56px" />}
        </span>}
        <button
          type="button"
          data-card-edit="true"
          onClick={(event) => {
            // A hold that became a drag ends with a click the browser still fires: not an open.
            const suppressed = gesture.consumeSuppressedClick();
            if (suppressed && event.detail !== 0) return;
            onOpen(e.id);
          }}
          className="tap flex min-w-0 flex-1 flex-col gap-1.5 text-left"
        >
          <EntryText e={e} m={m} measured={measured} pending={pending} stale={stale}
            unsaved={unsaved} lost={lost} meta={meta} previewTime={gesture.preview} />
          {snackImage && <span className="text-[12px] uppercase tracking-[0.08em] text-muted">Illustrative photo</span>}
        </button>
        <EntryPills e={e} measured={measured} onOpen={onOpen} onDetails={onDetails} />
      </span>
      {unsaved && (
        // Its own button, beside the card's — never one inside another — so the tap that saves it
        // again is not the tap that opens it.
        <button
          type="button"
          onClick={() => onRetry?.(e.id)}
          {...feedbackStateProps(retryState)}
          disabled={retryState === "pending"}
          className={`tap w-full px-[18px] pb-3 text-left text-tiny font-normal text-alert ${
            feedbackStateProps(retryState).className}`}
        >
          {UNSAVED_LINE}
        </button>
      )}
      {!unsaved && !pending && e.notSaved && (
        // Its own retry, never the plain "unsaved" one above (not the same write).
        <button
          type="button"
          onClick={() => onRetry?.(e.id)}
          {...feedbackStateProps(retryState)}
          disabled={retryState === "pending"}
          title={e.notSaved}
          className={`tap w-full px-[18px] pb-3 text-left text-tiny font-normal text-alert ${
            feedbackStateProps(retryState).className}`}
        >
          {NOT_SAVED_LINE}
        </button>
      )}
    </div>
  );
}

/** id-keyed capture method/confidence for the given (comma-joined) entry ids. `method` and
 *  per-item `confidence` live on the synced log_entries row (architecture §3.3), not on the legacy
 *  LoggedFood view model, and lib/types.ts is not this lane's file. So each row is read straight
 *  from the Phase 0 IndexedDB store by entry id; an id that predates sync, or a browser with no
 *  store, simply has no meta and the card renders exactly as it does today. */
export function useCaptureMeta(ids: string): Record<string, CaptureMeta> {
  const [meta, setMeta] = useState<Record<string, CaptureMeta>>({});

  useEffect(() => {
    let live = true;
    const h = accountHandle();
    void (async () => {
      const found: Record<string, CaptureMeta> = {};
      for (const id of ids === "" ? [] : ids.split(",")) {
        const row = await getRow(h, "log_entries", id).catch(() => undefined);
        const entry = captureMetaFrom(row);
        if (entry !== null) found[id] = entry;
      }
      if (live) setMeta(found);
    })();
    return () => { live = false; };
  }, [ids]);

  return meta;
}
