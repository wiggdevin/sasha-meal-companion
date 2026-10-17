"use client";

import { useId, useRef, useState } from "react";
import { DisclosureChevron, DisclosurePanel } from "@/components/ui/Disclosure";
import { FIBER_BAND_G, MACRO_CODES, TRACKED_MICROS, type NutrientCode } from "@/lib/nutrients/codes";
import { DRI_FEMALE_19_30, fiberBandState, percentDri } from "@/lib/nutrients/dri";
import { formatAmount } from "@/lib/nutrients/format";
import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";
import { dayHasPartialNutrition, dayNutrientTotals } from "@/lib/resolve";
import { PARTIAL_DAY_LINE } from "@/lib/nutrition-display";
import { PRESS_SLOP_PX, SWIPE_REVEAL_PX, swipeDismissDecision, todayDismissalKey } from "@/lib/today/presentation";
import type { ResolvedDay } from "@/lib/types";

const CARD_ID = "nutrients";

/** Session storage is optional: private modes and device policy can refuse it. */
function readDismissed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try { return window.sessionStorage.getItem(key) === "1"; } catch { return false; }
}

function writeDismissed(key: string): void {
  try { window.sessionStorage.setItem(key, "1"); } catch { /* the in-memory dismissal still holds */ }
}

const BAND_COPY = {
  under: `Under the ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g reference range`,
  "in-band": `In the ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g reference range`,
  over: `Over the ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g reference range`,
  unknown: "No fibre logged yet",
} as const;

/**
 * The band verdict, honest on a partial day (#21, review: Sol): a lower-bound total that already
 * reaches the band, or passes it, establishes "In" or "Over"; "Under" it cannot, so it says what is
 * counted. The fibre band is the card's only banded nutrient; the micros show % DRI, not a verdict.
 */
function bandCopy(band: keyof typeof BAND_COPY, grams: number | null, partial: boolean): string {
  if (partial && band === "under") return `At least ${formatAmount(MACRO_CODES.fiber, grams, "g")} counted`;
  return BAND_COPY[band];
}

const DRI_BY_CODE = new Map(DRI_FEMALE_19_30.map((row) => [row.code, row]));

/** The disclosure detail — twelve tracked micros with a % DRI where one applies. */
function MicroList({ totals }: { totals: Map<NutrientCode, NutrientTotal> }) {
  return (
    <dl className="flex flex-col gap-1.5 border-t border-hairline pt-3">
      {TRACKED_MICROS.map((code) => {
        const total = totals.get(code);
        const measured = total && total.itemsWithValue > 0;
        const pct = percentDri(total, DRI_BY_CODE.get(code));
        return (
          <div key={code} className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-caption font-normal text-graphite">{code.replace(/_/g, " ")}</dt>
            <dd className="shrink-0 text-caption tabular-nums text-charcoal ">
              {formatAmount(code, measured ? total.amount : null, total?.unit ?? "")}
              {pct !== null && measured && (
                <span className="pl-2 font-normal text-text-faint">{Math.round(pct)}% of reference</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * Micronutrients on Today — phase-2-real-logging.md, Client changes. Fibre reads against the
 * 20–25 g band, which targets.md sets BELOW the 25 g AI; the band wins on the screen and the DRI
 * row exists for export. Coverage is items-with-a-value ÷ all items (architecture §3.3), so a
 * partial day never reads as a complete one.
 *
 * The card can be cleared from Today for the viewed date (FluidVoice T04): a partial left swipe
 * reveals Clear, a full one clears it, and the visible Clear button does the same for keyboard and
 * screen-reader use. Clearing hides this card only — no log, plan or server row changes. The key
 * carries the account, the date and the card, so it returns on another date or account.
 */
export default function DayNutrients({ day, accountId = null }: {
  day: ResolvedDay;
  /** The bound account; without one a dismissal lasts only while the card is mounted. */
  accountId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const microsId = `${useId().replace(/:/g, "")}-micros`;
  const cardKey = todayDismissalKey(accountId ?? "", day.date, CARD_ID);
  const [dismissedHere, setDismissedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const swipe = useRef<{ x: number; y: number; moved: boolean; captured: boolean } | null>(null);
  const suppressClick = useRef(false);

  const totals = dayNutrientTotals(day);
  // Without an account the dismissal lives in memory only: nothing is written under a blank id.
  const dismissed = dismissedHere.has(cardKey) || (accountId !== null && readDismissed(cardKey));
  if (totals.size === 0 || dismissed) return null;

  const revealed = revealedKey === cardKey;
  const rest = revealed ? -SWIPE_REVEAL_PX : 0;
  const offset = dragX ?? rest;

  function dismiss() {
    if (accountId !== null) writeDismissed(cardKey);
    setDismissedHere((keys) => new Set(keys).add(cardKey));
    setRevealedKey(null);
    setDragX(null);
  }

  const fiber = totals.get(MACRO_CODES.fiber);
  const fiberG = fiber && fiber.itemsWithValue > 0 ? fiber.amount : null;
  const band = fiberBandState(fiberG);
  const coverage = microCoverage(totals, TRACKED_MICROS);
  const partial = dayHasPartialNutrition(day);

  return (
    <section className="relative" aria-label="Nutrients today">
      {offset < 0 && <button type="button" tabIndex={-1} aria-hidden="true" onClick={dismiss}
        className="absolute inset-y-0 right-0 flex w-16 items-center justify-center text-caption text-alert">
        Clear
      </button>}
      <div data-swipe-card data-swipe={revealed ? "revealed" : "rest"} className="shell relative"
        style={{ translate: `${offset}px 0`, touchAction: "pan-y",
          transition: dragX === null ? "translate 200ms cubic-bezier(0.2, 0.8, 0.2, 1)" : undefined }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          swipe.current = null;
          if (event.pointerType === "mouse" && event.button !== 0) return;
          // A press on Clear or the nutrient list belongs to that control, never to the swipe.
          if (event.target instanceof Element
            && event.target.closest("button, a, input, select, textarea, [role='button']")) return;
          swipe.current = { x: event.clientX, y: event.clientY, moved: false, captured: false };
        }}
        onPointerMove={(event) => {
          const start = swipe.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.hypot(dx, dy) > PRESS_SLOP_PX) start.moved = true;
          // Only a horizontal drag moves the card; a vertical one is the page's scroll. The pointer
          // is captured only once that horizontal intent is clear.
          if (!start.moved || Math.abs(dx) <= Math.abs(dy)) return;
          if (!start.captured) {
            start.captured = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          setDragX(Math.min(0, rest + dx));
        }}
        onPointerUp={(event) => {
          const start = swipe.current;
          swipe.current = null;
          setDragX(null);
          if (!start?.moved) return;
          suppressClick.current = true;
          const decision = swipeDismissDecision(rest + event.clientX - start.x, event.clientY - start.y);
          if (decision === "dismiss") dismiss();
          else setRevealedKey(decision === "reveal" ? cardKey : null);
        }}
        onPointerCancel={() => { swipe.current = null; setDragX(null); }}
        onClickCapture={(event) => {
          // Only the pointer's own follow-up click is swallowed; a keyboard activation always lands.
          if (!suppressClick.current || event.detail === 0) { suppressClick.current = false; return; }
          suppressClick.current = false;
          event.stopPropagation();
        }}
      >
      <div className="surface flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Fibre</span>
          <span className="flex items-center gap-1">
            <span className="text-subheading tabular-nums text-charcoal ">
              {formatAmount(MACRO_CODES.fiber, fiberG, "g")}
            </span>
            <button type="button" aria-label="Clear the nutrients card for this day" onClick={dismiss}
              className="tap -my-2 -mr-2 flex h-11 items-center justify-center rounded-full px-3 text-caption text-muted focus-visible:outline-2 focus-visible:outline-primary">
              Clear
            </button>
          </span>
        </div>
        <p className="text-caption font-normal text-graphite">{bandCopy(band, fiberG, partial)}</p>
        {/* #21: a partly measured recipe serving makes every total here a lower bound. */}
        {partial && <p className="text-caption font-normal text-muted" data-partial-day="">
          {PARTIAL_DAY_LINE}</p>}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? microsId : undefined}
          className="pill tap self-start"
        >
          <span className="pill-in flex h-11 items-center gap-1.5 px-4 text-caption text-graphite">
            {coverage.covered} of {coverage.tracked} nutrients have data today
            <DisclosureChevron open={open} size={16} />
          </span>
        </button>

        <DisclosurePanel id={microsId} open={open} keepMounted={false}><MicroList totals={totals} /></DisclosurePanel>

        <p className="text-tiny font-normal text-text-faint">
          Information only. These are reference values, not targets.
        </p>
      </div>
      </div>
    </section>
  );
}
