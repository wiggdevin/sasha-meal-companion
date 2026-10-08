"use client";

import Button from "@/components/ui/Button";
import MealTimeline from "./MealTimeline";
import styles from "./MealTimeline.module.css";
import dark from "./AfterDarkCards.module.css";
import { useMealReschedule } from "./useMealReschedule";
import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import MealNutritionDivider, { MealCalories, MealEatenButton, macroLabel } from "@/components/ui/MealNutritionDivider";
import MealFavoriteHeart, { type MealFavorite } from "@/components/MealFavoriteHeart";
import MealFigureLine from "@/components/MealFigureLine";
import { ASSISTANT_NAME } from "@/lib/brand";
import MealPhoto from "@/components/ui/MealPhoto";
import AutoHeight from "@/components/ui/AutoHeight";
import Fold from "@/components/ui/Fold";
import { useCardAttachScroll } from "@/components/useCardAttachScroll";
import { SPRINGS } from "@/lib/design/motion";
import { EmptyCardFlow, TrayFace } from "@/components/MealCardTray";
import type { Macros, ResolvedSlot, FoodComponent } from "@/lib/types";
import type { Food } from "@/lib/foods";
import { illustrativeMealImage } from "@/lib/today/meal-art";
import MealCardActions, { SWIPE_SETTLE } from "./MealCardActions";
import { useMealDetail, type DayTotals } from "./SlotCardDetail";
import { feedbackStateProps, type ActionFeedbackPhase } from "@/components/ui/ActionFeedback";
import { InsetSheetHost } from "@/components/Sheet";
import { SlotRuleMarkLine } from "@/components/SlotRuleMarks";
import Notice from "@/components/ui/Notice";

/* DESIGN.md Motion > Card entrance: 500–800 ms on
   cubic-bezier(0.2, 0.8, 0.2, 1), translateY 16 px, scale 0.98,
   120 ms stagger. Text stays crisp throughout. */
const ENTRANCE_EASE = [0.2, 0.8, 0.2, 1] as const;
const ENTRANCE_SECONDS = 0.6;
const ENTRANCE_STAGGER = 0.12;

/**
 * Entrance wrapper for the Today plan list. Plays once on mount — `initial`
 * only, and the caller keys each card by its slot id, so ticking a meal off
 * re-renders the card without replaying the entrance.
 *
   * MotionConfig's `reducedMotion="user"` only drops transforms; opacity would
   * still tween, so the whole entrance is gated on `useReducedMotion()` instead.
 */
export function SlotCardEnter({ index, children }: { index: number; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <>{children}</>;
  return (
    <motion.div
      className="relative has-[[data-rescheduling=true]]:z-20"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: ENTRANCE_SECONDS,
        ease: ENTRANCE_EASE,
        delay: index * ENTRANCE_STAGGER,
      }}
    >
      {children}
    </motion.div>
  );
}

/** How long a closing card waits for its tray to fold before it compacts. The tray is about 90 %
 *  folded by then, so the photo never shrinks over hanging ingredients, yet the two moves overlap
 *  into one continuous close instead of a stop between them (owner, 2026-10-04). */
export const FOLD_SECONDS = 0.24;

/** "08:00" -> "8:00 am". Display only; the stored shape stays 24h. */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** The chip's first word: Now/Next on the focus card, Eaten once ticked off, else the slot's name (meal cards v2). */
export function slotStatus(slot: Pick<ResolvedSlot, "label" | "eaten">, focusLabel?: "Now" | "Next"): string {
  if (slot.eaten) return "Eaten";
  return focusLabel ?? slot.label;
}

/** One thin pill on the photo: the meal's status word, then its time. */
function MealSlotPill({ slot, time, focusLabel }: {
  slot: Pick<ResolvedSlot, "slot" | "label" | "eaten">; time: string; focusLabel?: "Now" | "Next";
}) {
  const formatted = formatTime(time);
  const [clock, meridiem = ""] = formatted.split(" ");
  const status = slotStatus(slot, focusLabel);
  const spoken = status === slot.label ? "" : `, ${status.toLowerCase()}`;
  return <span role="img" aria-label={`${slot.label}${spoken}, scheduled for ${formatted}`} data-meal-time="true"
    data-meal-status={slot.eaten ? "eaten" : focusLabel ? focusLabel.toLowerCase() : "later"}
    className={`${dark.slotPill} ${slot.eaten ? dark.slotPillEaten : focusLabel ? dark.slotPillFocus : ""}`}>
    <span className={dark.slotPillStatus} aria-hidden="true">{status}</span>
    <span className={dark.slotPillDot} aria-hidden="true">·</span>
    <span className={dark.slotPillTime} aria-hidden="true"><span className="tabular-nums">{clock}</span> {meridiem.toUpperCase()}</span>
  </span>;
}

/** A refused save on the time pill: the shared red alert, not the white status fill. */
export const ALERT_PILL = "bg-alert text-charcoal";

export type SlotVariant = "focus" | "standard" | "compact";

export default function SlotCard({
  slot,
  variant,
  focusLabel,
  canSwap,
  onToggleEaten,
  onOpenSwap,
  onOpenEdit,
  foods,
  onSaveComponents,
  onTimeChange,
  onPlanWithCoach,
  onLogWhatYouAte,
  onAteSomethingElse,
  onClear,
  onDelete,
  dayTotals,
  eatenFeedback,
  mealFeedback,
  attachment,
  emptyReason,
  planMiss,
  favorite,
}: {
  slot: ResolvedSlot;
  /**
   * focus    — the current or next slot: promoted treatment.
   * standard — a meal that is not the focus: readable, but recedes.
   * compact  — coffee / hot chocolate: one line. A latte is not a meal.
   */
  variant: SlotVariant;
  focusLabel?: "Now" | "Next";
  canSwap: boolean;
  onToggleEaten: () => void;
  onOpenSwap: () => void;
  onOpenNote?: () => void;
  /** Open "what you actually had" for this slot. Optional so other callers keep compiling. */
  onOpenEdit?: () => void;
  foods?: Record<string, Food>;
  onSaveComponents?: (components: FoodComponent[]) => void | Promise<void>;
  onTimeChange?: (time: string) => void | Promise<void>;
  onPlanWithCoach?: () => void;
  onLogWhatYouAte?: () => void;
  /** A planned meal was not what was eaten: open the Plan panel in log mode. */
  onAteSomethingElse?: () => void;
  onClear?: () => void;
  onDelete?: () => void;
  /** Today's eaten and target totals, shown beside the meal in its read-only detail. */
  dayTotals?: DayTotals;
  /** Today's shared ActionFeedback phases for this slot: its eaten write and its meal edits. */
  eatenFeedback?: ActionFeedbackPhase;
  mealFeedback?: ActionFeedbackPhase;
  /** A flow this card started (ask the assistant, swap, log), rendered inside the card's own tray in
   *  place of its detail (components/Sheet.tsx, presentation "inset"). */
  attachment?: ReactNode;
  /** Why the generator left this empty slot empty ("No breakfast starch or fruit fits yet — try another food"). */
  emptyReason?: string | null;
  /** Why the generated plate still misses this meal's target inside usual portions. */
  planMiss?: string | null;
  /** The plate as a favorite meal; no heart is drawn without it (meal cards v3). */
  favorite?: MealFavorite;
}) {
  const [previewMacros, setPreviewMacros] = useState<Macros | null>(null);
  const reduceMotion = useReducedMotion();
  const shownMacros = previewMacros ?? slot.macros;
  const editor = onSaveComponents ? {
    foods: foods ?? {}, onSave: onSaveComponents, onPreview: setPreviewMacros,
  } : undefined;
  const attached = attachment != null && attachment !== false;
  const groupRef = useRef<HTMLDivElement | null>(null);
  // A flow closing takes the control that opened it away with it (the footer was its face), so focus
  // comes back to the footer once it returns, when it was in the flow or had fallen to the page.
  const [footerFocus, setFooterFocus] = useState(false);
  const wasAttached = useRef(attached);
  // A card with nothing planned has no footer: its Plan / Log control comes back with the card's own
  // header in the same commit, so focus goes straight to the one that opened the flow (Sol review S4).
  const planButton = useRef<HTMLButtonElement | null>(null);
  const logButton = useRef<HTMLButtonElement | null>(null);
  const openedBy = useRef<"plan" | "log" | "swap" | "other">("plan");
  const [returnTo, setReturnTo] = useState<"swap" | "toggle">("toggle");
  useLayoutEffect(() => {
    if (wasAttached.current && !attached) {
      const active = document.activeElement;
      const handOff = !active || active === document.body || !!groupRef.current?.contains(active);
      setFooterFocus(handOff);
      if (handOff && slot.meal === null) {
        (openedBy.current === "log" && logButton.current ? logButton : planButton).current?.focus({ preventScroll: true });
      }
      // A planned card's footer gives focus back to Swap when Swap opened the flow, else to its details control.
      if (slot.meal !== null) { setReturnTo(openedBy.current === "swap" ? "swap" : "toggle"); openedBy.current = "other"; }
    }
    wasAttached.current = attached;
  }, [attached, slot.meal]);
  const planEmpty = () => { openedBy.current = "plan"; onPlanWithCoach?.(); };
  const logEmpty = () => { openedBy.current = "log"; onLogWhatYouAte?.(); };
  const eatenControl = <MealEatenButton eaten={slot.eaten} label={slot.label} feedback={eatenFeedback}
    onToggleEaten={onToggleEaten} className={dark.zoneButton} />;
  const meal = useMealDetail(slot, onOpenEdit, dayTotals, onPlanWithCoach, editor, previewMacros,
    slot.eaten ? undefined : onAteSomethingElse, footerFocus,
    { eatenControl, onSwap: canSwap && !slot.eaten ? () => { openedBy.current = "swap"; onOpenSwap(); } : undefined,
      returnTo });
  // While a flow is open the card takes its compact hero, so the meal it acts on stays at the top and
  // the flow sits right under it on one screen (2026-10-04).
  const expanded = meal.expanded && !attached;
  // One flow giving way to another (Swap → Edit this meal) crossfades like the detail does.
  const flowKey = isValidElement(attachment) && attachment.key != null ? String(attachment.key) : "flow";
  // Closing runs in order: the tray folds first, then the card takes its compact shape, so the photo
  // never shrinks while the ingredients still hang below it.
  const [folding, setFolding] = useState(false);
  const [wasExpanded, setWasExpanded] = useState(expanded);
  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    setFolding(!expanded && !reduceMotion);
  }
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => setFolding(false), FOLD_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [folding]);
  useCardAttachScroll(groupRef, attached, !!reduceMotion);
  const gesture = useMealReschedule(slot.time, onTimeChange, canSwap ? onOpenSwap : undefined,
    slot.eaten ? undefined : onDelete);
  const shownTime = gesture.preview ?? slot.time;
  const mealProps = feedbackStateProps(mealFeedback);
  const cardProps = {
    ref: gesture.ref,
    "data-meal-card": true,
    "data-feedback-state": mealProps["data-feedback-state"],
    "data-rescheduling": gesture.preview !== null ? "true" : undefined,
    style: {
      position: "relative" as const,
      userSelect: "none" as const,
      translate: `${gesture.swipeX}px 0`,
      transition: gesture.dragging ? "none" : SWIPE_SETTLE,
      opacity: gesture.preview !== null ? .35 : undefined,
      zIndex: gesture.preview !== null ? 20 : undefined,
    },
  };
  const canAct = !slot.eaten && !!onClear && !!onDelete;
  const revealed = -gesture.swipeX;
  const withSwipe = (card: ReactNode) => !canAct ? card : (
    <MealCardActions label={slot.label} revealed={revealed} settle={gesture.dragging ? undefined : SWIPE_SETTLE}
      onClear={() => { gesture.closeActions(); onClear?.(); }}
      onDelete={() => { gesture.closeActions(); onDelete?.(); }}
      onToggle={gesture.toggleActions}>
      {card}
    </MealCardActions>
  );
  // Quiet lines from the day's generator run. Either can arrive after the card (the verified foods
  // load later), so each folds in rather than appearing by a cut; a flow open on the card hides them.
  const reasonLine = (className: string) => <AnimatePresence initial={false}>
    {emptyReason && !attached && <Fold key="reason">
      <p data-slot-empty-reason="true" className={`m-0 text-caption text-muted ${className}`}>{emptyReason}</p>
    </Fold>}
  </AnimatePresence>;
  const showMiss = !!planMiss && !attached && !slot.eaten && slot.meal !== null;
  // The generator's miss, inside the card's tray under the rule mark: a "needs a look" line.
  const missLine = <AnimatePresence initial={false}>
    {showMiss && <Fold key="miss">
      <div data-slot-plan-miss="true" className="pt-3"><Notice tone="attention" title={planMiss} /></div>
    </Fold>}
  </AnimatePresence>;
  const withActions = (card: ReactNode) => <div ref={groupRef} data-card-group="true" data-slot-card={slot.slot}
    data-card-attached={attached ? "true" : undefined} className="min-w-0 w-full max-w-full scroll-mt-3">
    {withSwipe(card)}
  </div>;
  /** The flow, inside whichever card body this slot draws. */
  const flowFace = (className: string) => <TrayFace key={`flow:${flowKey}`} className={className}>
    <InsetSheetHost>{attachment}</InsetSheetHost>
  </TrayFace>;
  if (slot.meal === null && variant !== "focus") {
    // An unplanned slot that is not the focus: one line, one action (audit 2026-09-22).
    return withActions(
      <div className={`shell min-w-0 w-full max-w-full ${styles.card} ${mealProps.className}`} {...cardProps}>
        <div className="surface flex flex-col">
          <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[16px] font-medium text-charcoal">{slot.label}</span>
              <span className="text-tiny tabular-nums text-muted">{formatTime(slot.time).toUpperCase()}</span>
            </span>
            {!attached && <Button ref={planButton} onClick={planEmpty}>Plan</Button>}
          </div>
          {reasonLine("px-4 pb-3")}
          <EmptyCardFlow open={attached}>{flowFace("px-4 pb-4")}</EmptyCardFlow>
        </div>
      </div>
    );
  }
  if (slot.meal === null) {
    return withActions(
      <div className={`shell min-w-0 w-full max-w-full ${styles.card} ${mealProps.className}`} {...cardProps}>
        <div className="surface flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[16px] font-medium text-charcoal">
              {focusLabel && <span data-meal-status={focusLabel.toLowerCase()} className="eyebrow mr-2 text-muted">{focusLabel}</span>}
              {slot.label}
            </span>
            <span className="text-tiny font-normal tabular-nums text-muted">
              {formatTime(slot.time).toUpperCase()}
            </span>
          </div>
          {!attached && <>
            <p className="m-0 text-caption text-muted">Nothing planned yet.</p>
            {reasonLine("")}
            <div className="flex flex-col gap-2">
              <Button ref={planButton} block variant="primary" onClick={planEmpty}>{`Plan with ${ASSISTANT_NAME}`}</Button>
              <Button ref={logButton} block variant="tertiary" onClick={logEmpty}>Log what you ate</Button>
            </div>
          </>}
          <EmptyCardFlow open={attached}>{flowFace("")}</EmptyCardFlow>
        </div>
      </div>
    );
  }
  const editSurface = <>
    {gesture.timeline && <MealTimeline position={gesture.timeline} time={shownTime} name={slot.meal.name} />}
    {gesture.swipeX > 12 && <span className={styles.swapHint} aria-hidden="true">Swap →</span>}
    {!attached && <button type="button" data-card-edit="true" aria-hidden="true" tabIndex={-1}
      className="tap absolute inset-0 z-[1] rounded-[inherit]"
      onClick={(event) => {
        const suppressed = gesture.consumeSuppressedClick();
        if (suppressed && event.detail !== 0) return;
        // A tap opens the card in place; keyboard users have the footer's explicit expander.
        meal.toggle();
      }} />}
    {(gesture.saving || gesture.error) && <span role={gesture.error ? "alert" : "status"}
      className={`pointer-events-none absolute -top-3 right-4 z-20 rounded-full px-4 py-2 text-tiny shadow-lg ${
        gesture.error ? ALERT_PILL : "bg-primary text-on-primary"}`}>
      {gesture.error ?? (gesture.saving ? "Saving time…" : `${formatTime(shownTime)} · Release to save`)}
    </span>}
  </>;
  const shellClass = slot.eaten ? "meal-card" : "shell";
  // Eaten keeps full colour and contrast: the chip and the eaten button carry the state (meal cards v2).
  const surfaceClass = slot.eaten ? "meal-card-in meal-card-complete" : "surface";
  const illustrativeImage = illustrativeMealImage(slot.meal.name, slot.components);
  // v3: an open card takes the compact header too, so its ingredients sit near the top; a focus card
  // grows back to its featured form once the tray has folded.
  const compact = variant !== "focus" || meal.expanded || folding || attached;
  // Opening a card is one shape becoming another (2026-10-01): the photo grows from the left into the
  // top, the title, calories and time glide to their new places, and the card's height springs, so
  // the cards below slide rather than jump. Reduced motion: MotionConfig drops the layout moves.
  const morph = reduceMotion ? { duration: 0 } : SPRINGS.gentle;
  const glide = { layout: "position" as const, layoutDependency: compact, transition: morph };

  return withActions(
    <div className={`${shellClass} min-w-0 w-full max-w-full ${styles.card} ${mealProps.className} ${compact ? dark.compact : ""}`}
      {...cardProps} data-after-dark-meal="true"
      data-card-density={compact ? "compact" : "featured"}>
      {editSurface}
      <div className={`${surfaceClass} flex flex-col gap-0 matte matte-grain ${dark.mealSurface}`}>
        {/* Every size change inside springs in its own box (the hero here, the macro panel and the
            tray in theirs), so the card's own height is plain layout and follows them in the same
            frame. A second spring around them all chased their moving total and lagged, then caught
            up with a lurch (owner, 2026-10-04: the cards below shot up while the card still folded). */}
        <AutoHeight spring="gentle">
          <div data-meal-header="true" data-after-dark-hero="true" className={dark.hero}>
            <MealPhoto src={illustrativeImage} className={dark.heroPhoto} compact={compact} transition={morph} />
            <div className={dark.heroFooter}>
              <motion.h3 className={dark.heroTitle} {...glide}>{slot.meal.name}</motion.h3>
              <motion.div data-meal-figures="" className={dark.figures} {...glide}
                role={compact ? "img" : undefined} aria-label={compact ? macroLabel(shownMacros) : undefined}>
                <MealCalories kcal={shownMacros.kcal} />
                {compact && <MealFigureLine macros={shownMacros} full={meal.expanded} />}
              </motion.div>
            </div>
            <motion.div className={dark.heroTime} {...glide}><MealSlotPill slot={slot} time={shownTime} focusLabel={focusLabel} /></motion.div>
            {favorite && <MealFavoriteHeart label={slot.meal.name} favorite={favorite} />}
          </div>
        </AutoHeight>
        <MealNutritionDivider macros={shownMacros} compact={compact} />
        {/* One container (2026-10-04, owner: "Why isn't the card that's being edited just the top of
            this card?"): a flow takes the place of the detail inside the beige tray. The tray's height
            springs (frame first) while one face blurs out and the next blurs in (content after);
            closing runs the same way back. */}
        <div className={`matte-reset ${dark.details}`} data-card-tray={attached ? "flow" : "detail"}>
          <AutoHeight spring="gentle">
            <AnimatePresence mode="wait" initial={false}>
              {attached ? flowFace(dark.flowFace) : <TrayFace key="detail" className={dark.detailFace}>
                {/* Saved content against the current food rules: on the beige tray, never on the hero. */}
                <SlotRuleMarkLine mark={meal.ruleMark} />
                {missLine}
                <AnimatePresence initial={false}>{meal.detail}</AnimatePresence>
                {meal.footer}
              </TrayFace>}
            </AnimatePresence>
          </AutoHeight>
        </div>
      </div>
    </div>
  );
}
