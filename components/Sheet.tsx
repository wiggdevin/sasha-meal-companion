"use client";

import { motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { MORPH, SPRINGS } from "@/lib/design/motion";
import { springScrollIntoView } from "@/lib/dom/spring-scroll";
import { POPOVER_GUTTER } from "@/lib/dom/popover-place";
import { lockBodyScroll } from "@/lib/dom/scroll-lock";
import { usePopoverPlacement } from "@/lib/dom/use-popover-placement";
import { excludeElement, isSheetCloseKey, nextTrapFocus } from "@/lib/dom/sheet-a11y";
import AutoHeight from "@/components/ui/AutoHeight";
import { CloseIcon } from "@/components/ui/CloseButton";
import Button from "@/components/ui/Button";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * "attached" renders every Sheet under it as a panel joined to the bottom of the card that opened
 * it: no scrim, no scroll lock, no modal pop-up (the recipe hub's "Build my own" editor).
 *
 * "inset" renders it inside the card itself (2026-10-04, owner: "this should not be two separate
 * cards. It should be one card with what's currently selected at the top"): a meal card's flow takes
 * the place of the card's own detail, in the card's beige tray, with no chrome, margin or scroller of
 * its own. The card draws the container and its crossfade (components/SlotCard.tsx); the sheet draws
 * a slim mode row (glyph, the flow's name, close) instead of any header that would repeat the card.
 */
export type SheetPresentationKind = "modal" | "attached" | "inset";
const SheetPresentation = createContext<SheetPresentationKind>("modal");

export function AttachedSheetHost({ children }: { children: ReactNode }) {
  return <SheetPresentation.Provider value="attached">{children}</SheetPresentation.Provider>;
}

export function InsetSheetHost({ children }: { children: ReactNode }) {
  return <SheetPresentation.Provider value="inset">{children}</SheetPresentation.Provider>;
}

export function useSheetPresentation() {
  return useContext(SheetPresentation);
}

/** The gap between a card and the panel joined under it (globals.css .attached-sheet); it opens and
 *  closes with the panel rather than appearing at once. */
const ATTACHED_GAP = 8;

function AttachedSheet({ title, subtitle, header, onClose, children, footer }: {
  title: string; subtitle?: string; header?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    // Bring the panel into view on the same spring it grows on. A meal card scrolls itself, since
    // only it knows how far it will fold (components/useCardAttachScroll.ts).
    const stopScroll = panel.closest("[data-card-group]") ? () => {} : springScrollIntoView(panel, !!reduceMotion);
    function onKeyDown(e: KeyboardEvent) {
      if (isSheetCloseKey(e.key)) onCloseRef.current();
    }
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      stopScroll();
      panel.removeEventListener("keydown", onKeyDown);
    };
    // Runs once per opened panel; reduced motion is read at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The panel grows out of the card's lower edge and folds back into it on the card's own spring,
  // both ways (MORPH, after the Day card's board): the panel itself never fades, its content fades in
  // once it has room and out as it starts to fold.
  return <motion.section ref={panelRef} tabIndex={-1} aria-label={title} data-attached-sheet="true"
    className="attached-sheet min-w-0 w-full max-w-full overflow-clip outline-none"
    initial={reduceMotion ? false : { height: 0, marginTop: 0 }}
    animate={{ height: "auto", marginTop: ATTACHED_GAP }}
    exit={{ height: 0, marginTop: 0, transition: reduceMotion ? { duration: 0 } : MORPH.frame }}
    transition={reduceMotion ? { duration: 0 } : MORPH.frame}>
    {/* Content that arrives after the panel has opened (suggestions, a reply, an error) grows the
        panel on the same spring instead of jumping it (owner, 2026-10-04). */}
    <AutoHeight spring="gentle">
    <motion.div className="flex min-w-0 w-full max-w-full flex-col gap-3 px-4 pb-4 pt-3"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1, transition: reduceMotion ? { duration: 0 } : MORPH.contentIn }}
      exit={{ opacity: 0, transition: reduceMotion ? { duration: 0 } : MORPH.contentOut }}>
    <div className="flex min-w-0 shrink-0 items-start justify-between gap-3">
      {header ?? <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="m-0 flex items-center gap-2 text-body-md font-medium text-charcoal">
          <span className="truncate">{title}</span>
        </h2>
        {subtitle && <p className="m-0 text-tiny text-muted">{subtitle}</p>}
      </div>}
      <button type="button" onClick={onClose} aria-label="Close"
        className="tap -mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center text-muted">
        <CloseIcon />
      </button>
    </div>
    {/* Grows, never scrolls inside (DESIGN.md §Layout, scroll ownership): the page is the scroller. */}
    <div className="attached-sheet-body min-w-0">{children}</div>
    {footer && <div className="min-w-0 shrink-0">{footer}</div>}
    </motion.div>
    </AutoHeight>
  </motion.section>;
}

/** What an inset flow's mode row says: a short name for the flow ("Plan with …", "Swap") and its
 *  glyph. Without it the row reads the sheet's `title`. */
export type SheetInset = { label: string; glyph?: ReactNode };

/**
 * A flow inside its meal card (presentation "inset"). Focus moves into it on open, Escape closes it,
 * and it never scrolls inside: the card grows and the page scrolls. The card owns the motion.
 */
function InsetSheet({ title, subtitle, inset, onClose, children, footer }: {
  title: string; subtitle?: string; inset?: SheetInset; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    function onKeyDown(e: KeyboardEvent) {
      if (isSheetCloseKey(e.key)) onCloseRef.current();
    }
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, []);
  return <section ref={panelRef} tabIndex={-1} aria-label={title} data-inset-sheet="true"
    className="flex min-w-0 w-full max-w-full flex-col gap-3 outline-none">
    <div data-sheet-mode-row="" className="flex min-h-11 min-w-0 items-center gap-2">
      {inset?.glyph && <span aria-hidden="true" className="flex shrink-0 text-primary">{inset.glyph}</span>}
      <h2 className="m-0 min-w-0 flex-1 truncate text-caption font-semibold text-charcoal">{inset?.label ?? title}</h2>
      <Button variant="ghost" shape="circle" size="sm" aria-label="Close" onClick={onClose}
        className="-mr-1 shrink-0 text-muted"><CloseIcon /></Button>
    </div>
    {subtitle && <p data-sheet-note="" className="-mt-2 m-0 text-tiny text-muted">{subtitle}</p>}
    <div className="min-w-0">{children}</div>
    {footer && <div className="min-w-0">{footer}</div>}
  </section>;
}

/* The modal pop-up is the card's liquid glass one step stronger (globals.css .sheet-surface,
   KIT.md §8): 28 px corners all round, a hairline, a soft shadow on every side. It sits above the
   floating chrome. */

/**
 * The one chrome surface for every "pick something" moment in the app. Under AttachedSheetHost it
 * grows out of the card that opened it; everywhere else it pops up as a card next to the button
 * that opened it (2026-10-03: nothing slides up from the bottom any more).
 */
export default function Sheet({ inset, ...props }: {
  /** Names the dialog or panel for assistive tech, and is the visible title unless `header` is set. */
  title: string;
  subtitle?: string;
  /** Replaces the visible title block (the close button stays): a flow with its own header. Never
   *  drawn inside a card (inset), where the card above already names the meal. */
  header?: ReactNode;
  /** The mode row's name and glyph inside a card (inset). */
  inset?: SheetInset;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const presentation = useSheetPresentation();
  if (presentation === "inset") return <InsetSheet inset={inset} {...props} />;
  return presentation === "attached" ? <AttachedSheet {...props} /> : <ModalSheet {...props} />;
}

const POP_FROM = 0.86;

function ModalSheet({
  title,
  subtitle,
  header,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  header?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Reduced motion: a plain fade, no scale.
  const reduceMotion = useReducedMotion();
  const scrimDuration = reduceMotion ? 0.12 : 0.2;

  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The card sits next to the button that opened it, below when there is room, else above, and
  // scales out of that button and back into it (lib/dom/popover-place.ts).
  const { placement, trigger } = usePopoverPlacement(dialogRef, cardRef, bodyRef);
  const triggerRef = useRef(trigger);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Background scroll lock (Finding #88) — the page behind the card must not scroll while it's open.
  useEffect(() => lockBodyScroll(document.body), []);

  // Focus trap + Escape-to-close (Finding #61): move focus in on open,
  // restore it on close, keep Tab/Shift+Tab inside the dialog, and let
  // Escape close it like any other dialog. A layout effect, so its cleanup runs while the card is
  // still in the document and can tell that focus is inside it (a passive cleanup runs after the
  // node is gone, when focus has already fallen to <body>).
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement as HTMLElement | null;
    // A tap on iOS focuses nothing, so the trigger the card grew out of takes focus back instead.
    const returnTo = active && active !== document.body ? active
      : (triggerRef.current instanceof HTMLElement ? triggerRef.current : null);
    // dialogRef spans the outer wrapper, so its own scrim close button
    // (a sibling of the card's real content) is in this list too — drop
    // it before it can take initial focus or anchor the Tab trap.
    const focusableNow = () => excludeElement(
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("disabled")),
      scrimRef.current
    );
    // A flow that names its own first field (`data-autofocus`, e.g. a search box) starts there;
    // otherwise the first control. Never scrolls: the card is placed, it must not move to focus.
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusableNow()[0])?.focus({ preventScroll: true });

    function onKeyDown(e: KeyboardEvent) {
      if (isSheetCloseKey(e.key)) {
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        // Buttons can arrive after an async suggestion and Send can change disabled state.
        const next = nextTrapFocus(focusableNow(), document.activeElement as HTMLElement | null, e.shiftKey);
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Three flows hand off from this card straight to another
      // (LogFoodSheet -> AddFoodSheet, CaptureSheet -> LogFoodSheet,
      // BarcodeScanSheet -> ScanConfirmSheet) under AnimatePresence's
      // default 'sync' mode, which keeps this card mounted through its
      // exit animation while the new one is already open and has moved
      // focus into itself. Only restore focus if it's still inside THIS
      // dialog — otherwise this delayed cleanup would yank focus out of
      // the card that has since taken over.
      if (dialog.contains(document.activeElement) && returnTo?.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, []);

  const origin = placement ? `${placement.originX}px ${placement.originY}px` : "50% 50%";
  return (
    <div
      ref={dialogRef}
      className="sheet-popover-root fixed inset-0 z-[60] min-w-0 w-full max-w-full"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.div className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: scrimDuration }}>
        <button
          ref={scrimRef}
          type="button"
          aria-label="Close"
          className="sheet-popover-scrim absolute inset-0"
          onClick={onClose}
        />
      </motion.div>
      {/* The card scales out of the button that opened it on the snappy spring and folds back
          into it on close. */}
      <motion.div
        ref={cardRef}
        data-popover-side={placement?.side ?? "center"}
        className="sheet-surface absolute flex min-w-0 max-w-full flex-col gap-4 px-4 pb-5 pt-4"
        style={{
          // Above its trigger, the card hangs from its bottom edge, so content that grows after
          // opening (search results) extends it upward instead of shifting it for a frame.
          top: placement?.bottom !== undefined ? "auto" : placement?.top ?? POPOVER_GUTTER,
          bottom: placement?.bottom,
          left: placement?.left ?? POPOVER_GUTTER,
          width: placement?.width ?? `calc(100% - ${POPOVER_GUTTER * 2}px)`,
          maxHeight: placement?.maxHeight,
          transformOrigin: origin,
        }}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: POP_FROM }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0, transition: { duration: 0.12 } }
          : { opacity: 0, scale: POP_FROM, transition: { ...SPRINGS.smooth, visualDuration: 0.24, opacity: { duration: 0.16 } } }}
        transition={reduceMotion ? { duration: 0.16 } : { ...SPRINGS.snappy, opacity: { duration: 0.18 } }}
      >
        <div className="flex min-w-0 shrink-0 items-start justify-between gap-3">
          {header ?? <div className="flex min-w-0 flex-col gap-1 pt-1">
            {/* Screen and sheet titles speak in the display face (DESIGN.md §Typography; Kimi K1). */}
            <h2
              className="m-0 font-display text-heading font-light tracking-display-md leading-none"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="m-0 text-tiny font-normal leading-body-sm text-muted">
                {subtitle}
              </p>
            )}
          </div>}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="sheet-close tap flex shrink-0 items-center justify-center"
          >
            <CloseIcon />
          </button>
        </div>
        <div ref={bodyRef} className="sheet-body min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">{children}</div>
        {footer && <div className="min-w-0 shrink-0">{footer}</div>}
      </motion.div>
    </div>
  );
}

/**
 * Standalone selection pill — `.pill` shell around a `.pill-in` interior
 * (globals.css). Active uses the ink gradient segment from Foods.dc.html.
 */
export function Pill({
  active,
  muted,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  muted?: boolean;
  /** For a toggle whose store is unreachable — the state still shows, the tap does nothing. */
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pill inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        disabled={disabled}
        className={`pill-in tap flex items-center justify-center px-4 disabled:opacity-40 text-tiny font-normal ${
          active ? "text-on-primary" : muted ? "text-muted line-through" : "text-graphite"
        }`}
        style={active ? { background: "var(--grad-ink)" } : undefined}
      >
        {children}
      </button>
    </div>
  );
}
