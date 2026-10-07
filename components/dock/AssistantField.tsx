"use client";

import {
  useEffect, useRef, useState,
  type FocusEvent, type FormEvent, type KeyboardEvent, type RefObject,
} from "react";
import {
  AnimatePresence, animate, motion, useMotionValue, useTransform, type PanInfo,
} from "motion/react";
import {
  Camera, ChevronDown, ImagePlus, MessageCircle, Plus, Weight, X, type LucideIcon,
} from "lucide-react";
import { useCapabilities } from "@/components/CapabilitiesProvider";
import CoachMic from "@/components/CoachMic";
import { useComposerInput } from "@/components/coach/use-composer-input";
import { deliverDockText } from "@/components/coach/use-dock-submit";
import { deliverDockIntent, type DockIntent } from "@/components/coach/attachments/dock-handoff";
import { useDockComposerState } from "@/components/coach/use-dock-composer-state";
import WeighInField, { type WeightUnit } from "@/components/coach/attachments/WeighInField";
import { COMPOSER_OFFLINE_COPY } from "@/lib/coach/chat-state";
import { ASSISTANT_NAME } from "@/lib/brand";
import { Round, SendGlyph } from "@/components/coach/round-button";
import {
  BUBBLE, FADE, GROW, INSTANT, MORPH, PRESS, SPLIT, TRAY_OPEN, lensVar, rubber, sheen, sheenOff,
} from "@/components/dock/dock-motion";
import { loadStore } from "@/lib/store";
import styles from "@/components/TabBar.module.css";
import { ASK_INPUT_CLASS, AskPop, AskSkin } from "@/components/dock/AskShell";
import { spring } from "@/lib/design/motion";
import UnreadDot from "@/components/ui/UnreadDot";
import { UNREAD_SUFFIX, useHasUnread } from "@/components/coach/unread-threads";

type TileKey = "camera" | "upload" | "weigh-in" | "chat";
type Tile = { key: TileKey; label: string; name: string; icon: LucideIcon };
/* Camera and Upload send a photo to the chat, read for a barcode first (U18, 2026-10-04: the Scan
   tile is gone, the camera covers plates, menus, labels and barcodes); Weigh in opens its own small
   card (WeighInField); Chat opens the conversation, handing over any typed draft the same way the
   field's own Send does. */
const TILES: Tile[] = [
  { key: "camera", label: "Camera", name: "Take a photo", icon: Camera },
  { key: "upload", label: "Upload", name: "Upload a photo", icon: ImagePlus },
  { key: "weigh-in", label: "Weigh in", name: "Weigh in", icon: Weight },
  { key: "chat", label: "Chat", name: "Open chat", icon: MessageCircle },
];

function preferredWeightUnit(): WeightUnit {
  const settings = loadStore().settings as unknown as { weightUnit?: unknown };
  return settings.weightUnit === "kg" ? "kg" : "lb";
}

/** A flick counts when it travels far enough or fast enough (px, px/s). */
const FLICK_DISTANCE = 24;
const FLICK_SPEED = 350;

/**
 * The assistant's ask field. Closed it is a round glass bubble; open it is the composer: an attach
 * control, the text, a clear control when there is text, and one main control that records while
 * the field is empty and sends once it holds words. Tapping + or flicking a thumb up on the field
 * grows it upward into the attach tray; flicking down puts the tray away.
 */
export default function AssistantField({ open, width, onCoach, reduce, onOpen, onClose, dock,
  chatOpen = false, onOpenChat, onCloseChat }: {
  open: boolean; width: number; onCoach: boolean; reduce: boolean;
  onOpen: () => void; onClose: () => void; dock: RefObject<HTMLElement | null>;
  /** The chat overlay is up over this page (U22): the field is its composer. */
  chatOpen?: boolean; onOpenChat?: () => void; onCloseChat?: () => void;
}) {
  const capabilities = useCapabilities();
  // A delivered weekly review waits unopened (components/coach/unread-threads.ts): the bubble and
  // the Chat tile carry a dot and say so in their names.
  const unread = useHasUnread();
  const askName = unread ? `Ask ${ASSISTANT_NAME}, ${UNREAD_SUFFIX}` : `Ask ${ASSISTANT_NAME}`;
  // Camera and Upload both resolve to a "photo" capture (Grok audit 2026-10-02, finding 4: the
  // deleted page composer's own camera button gated on captureMethods.includes("photo"), and these
  // two tiles never carried that gate forward). Chat and Weigh-in have no flag.
  const tiles = TILES.filter((tile) => {
    if (tile.key === "camera" || tile.key === "upload") return capabilities.captureMethods.includes("photo");
    return true;
  });
  /** A chat is listening: /coach itself, or the overlay over this page. */
  const live = onCoach || chatOpen;
  const dockState = useDockComposerState(live);
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(preferredWeightUnit);
  // The typed weight outlives the weigh-in card, so closing it mid-entry keeps the number.
  const [weightDraft, setWeightDraft] = useState("");
  /** Shared by the field's own Send, the Chat tile and Weigh-in's follow-ups: a dock question goes
   *  to the chat that is listening (/coach, or the overlay over this page); on any other page it
   *  opens the overlay, which sends it once its thread is ready (U22, 2026-10-04: no route change).
   *  DeepSeek audit 2026-10-02, finding 2: a chat that declines the turn says so synchronously, so
   *  use-composer-input's send() keeps the draft (use-dock-submit's `detail.accepted`). */
  function submitText(text: string): boolean {
    const taken = deliverDockText(text);
    if (!live) onOpenChat?.();
    return taken;
  }
  const controls = useComposerInput(dockState.disabled, submitText);
  const {
    input, draft, editing, caretAtEnd, listening, reviewNeeded, micNotice, readBox, send, textEvents, micEvents,
  } = controls;
  const measured = width > 0;
  const hasText = draft.trim().length > 0;
  /* Grok audit 2026-10-02, finding 1: this field used to override CoachMic's own caret-sensitive
   * readyToSend with `hasText && !listening`, so the one control became Send the instant the box
   * held anything and a dictated transcript could never be appended to. canSend restores the old
   * composer's rule (components/coach/Composer.tsx, before the dock-composer consolidation): a
   * distinct Send sits beside Record only while the caret is collapsed at the draft's end; moved
   * away or not editing, CoachMic's own readyToSend (useComposerInput's micEvents) takes over. */
  const canSend = editing && caretAtEnd && hasText && !listening && !reviewNeeded;
  // A turn in flight is shown once, in the transcript above (/coach or the overlay) and by the
  // header mark's quicker motion; the field keeps its own placeholder (Kimi K5, 2026-10-04).

  // The tray belongs to one opening of the field; closing the field puts it away.
  const [trayFor, setTrayFor] = useState(false);
  const tray = open && trayFor;
  // Weigh-in replaces the tray with its own small field (ComposerToolbar did the same above the
  // page's composer); it is its own popover, not a tray tile, so it survives the tray closing.
  const [weighing, setWeighing] = useState(false);
  // Grok audit 2026-10-02, finding 5: a relatedTarget-less blur on Today folds the field straight
  // through onClose without going through Escape's own `setWeighing(false)`, so `weighing` by
  // itself outlived a closed field and the popover kept floating over the collapsed bubble. `tray`
  // just above already derives its visibility from `open` the same way; weighVisible does too,
  // rather than chasing `open` with a reset of its own.
  const weighVisible = open && weighing;
  // Grok audit 2026-10-02 (final round): hiding them was not enough — a fold kept both set, so the
  // next opening sprang straight back into the tray or the popover. Each opening starts fresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) { setTrayFor(false); setWeighing(false); }
  }
  const base = useMotionValue(BUBBLE);
  const pull = useMotionValue(0);
  const height = useTransform(() => base.get() + pull.get());
  const trayReveal = useTransform(height, [BUBBLE + 20, TRAY_OPEN], [0, 1]);
  const trayRise = useTransform(trayReveal, [0, 1], [12, 0]);
  useEffect(() => {
    const target = tray ? TRAY_OPEN : BUBBLE;
    if (reduce) { base.jump(target); return; }
    const motionRun = animate(base, target, GROW);
    return () => motionRun.stop();
  }, [tray, reduce, base]);

  // The chat over the page disables the field while it restores its thread, and a disabled field
  // drops focus to <body>. Once the chat is ready, the composer takes the focus back.
  const wasDisabled = useRef(dockState.disabled);
  useEffect(() => {
    const was = wasDisabled.current;
    wasDisabled.current = dockState.disabled;
    if (!chatOpen || !was || dockState.disabled) return;
    if (!document.activeElement || document.activeElement === document.body) input.current?.focus({ preventScroll: true });
  }, [chatOpen, dockState.disabled, input]);

  const camera = useRef<HTMLInputElement>(null);
  const attach = useRef<HTMLButtonElement>(null);
  /** The weigh-in card closes back to the control that opened its way in (the + button). */
  function closeWeighIn() {
    setWeighing(false);
    attach.current?.focus({ preventScroll: true });
  }
  const library = useRef<HTMLInputElement>(null);

  /** A picked photo stays on this page too: it goes to the chat over it (U22). */
  function deliver(intent: DockIntent) {
    setTrayFor(false);
    deliverDockIntent(intent);
    if (!live) onOpenChat?.();
  }

  function openWeighIn() {
    setTrayFor(false);
    // Grok audit 2026-10-02, finding 5: weightUnit was only ever read at mount, so a kg/lb change
    // made in Settings was ignored until the dock remounted. Read it again each time the field opens.
    setWeightUnit(preferredWeightUnit());
    setWeighing(true);
  }

  // The picker must open inside this tap: iOS ignores a file-input click outside a gesture.
  function pick(tile: "camera" | "upload") {
    (tile === "camera" ? camera : library).current?.click();
  }

  /**
   * The tray's way into the conversation. A typed draft travels with it, the same way the field's
   * own Send does. With nothing typed it opens the chat over this page; where a chat is already
   * showing it only closes the tray and returns focus to the composer.
   */
  function chat() {
    setTrayFor(false);
    const text = readBox().trim();
    if (text) { send(text); return; }
    if (!live) onOpenChat?.();
    input.current?.focus({ preventScroll: true });
  }

  function picked(files: FileList | null) {
    const file = files?.[0];
    if (file) deliver({ kind: "photo", file });
  }

  function clear() {
    micEvents.writeBox("");
    input.current?.focus({ preventScroll: true });
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (readBox().trim()) send(readBox());
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (tray) setTrayFor(false);
      else if (weighing) setWeighing(false);
      else if (event.currentTarget.value) { event.currentTarget.value = ""; textEvents.onChange(event); }
      else if (chatOpen) onCloseChat?.();
      else { event.currentTarget.blur(); if (!onCoach) onClose(); }
      return;
    }
    textEvents.onKeyDown(event);
  }

  function blurred(event: FocusEvent<HTMLElement>): void {
    // Tapping away from an empty field folds it back, unless focus moved within the dock or a chat
    // is showing above it (the overlay closes on its own terms).
    if (live || readBox().trim()) return;
    const next = event.relatedTarget as Node | null;
    if (next && dock.current?.contains(next)) return;
    if (document.activeElement && dock.current?.contains(document.activeElement)) return;
    onClose();
  }

  const touchPan = useRef(false);
  function panStart(event: PointerEvent) { touchPan.current = event.pointerType !== "mouse"; }
  function panMove(_: PointerEvent, info: PanInfo) {
    if (!touchPan.current || reduce) return;
    pull.set(rubber(-info.offset.y, tray ? 36 : 64));
  }
  function panEnd(_: PointerEvent, info: PanInfo) {
    if (!touchPan.current) return;
    const up = info.offset.y < -FLICK_DISTANCE || info.velocity.y < -FLICK_SPEED;
    const down = info.offset.y > FLICK_DISTANCE || info.velocity.y > FLICK_SPEED;
    if (!tray && up) setTrayFor(true);
    else if (tray && down) setTrayFor(false);
    // Hand the finger's speed to the settle, so release has no seam (apple-design §5).
    animate(pull, 0, reduce ? INSTANT : { ...GROW, velocity: -info.velocity.y });
  }

  // Closed: a speech bubble (the owner, 2026-10-04: no spark logo in any chat). Open: + for the
  // tray, which turns to a chevron to put the tray away.
  const leading = !open ? "chat" : tray ? "hide" : "plus";
  const Leading = leading === "hide" ? ChevronDown : Plus;

  return <motion.div data-dock-assistant="true" data-open={open ? "true" : undefined}
    data-tray={tray ? "true" : undefined} data-current={onCoach ? "true" : undefined}
    className="relative shrink-0"
    style={{ height, width: open && measured ? width : BUBBLE, flex: !measured && open ? "1 1 0" : undefined }}
    initial={false} animate={measured ? { width: open ? width : BUBBLE } : undefined}
    transition={reduce ? INSTANT : MORPH}
    whileTap={reduce || open ? undefined : { scale: 0.92 }}
    onPanStart={open ? panStart : undefined} onPan={open ? panMove : undefined} onPanEnd={open ? panEnd : undefined}
    onPointerMove={sheen} onPointerLeave={sheenOff}>
    {/* The visual (clipped, rounded) card. Split from the outer box above so Weigh-in's popover,
        a sibling below, can sit above it without being clipped by its own grown-tray overflow. */}
    <div data-open={open ? "true" : undefined} data-current={onCoach ? "true" : undefined}
      className={`${styles.glass} ${styles.assistant} absolute inset-0 overflow-hidden`}
      style={{ ...lensVar(open ? "pill" : "round"), borderRadius: 32 }}>
    <AskSkin open={open} reduce={reduce} />

    <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1}
      aria-hidden="true" onChange={(event) => { picked(event.target.files); event.target.value = ""; }} />
    <input ref={library} type="file" accept="image/*" className="sr-only" tabIndex={-1}
      aria-hidden="true" onChange={(event) => { picked(event.target.files); event.target.value = ""; }} />

    <motion.div role="group" aria-label="Add to your question" inert={!tray}
      className={`${styles.tray} absolute inset-x-0 top-0 grid gap-2 px-3 pt-3`}
      style={{ opacity: trayReveal, y: trayRise, bottom: BUBBLE,
        gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
      {tiles.map((tile, index) => {
        const Icon = tile.icon;
        // Every tile but Chat (it only opens the conversation) follows the field's own disable.
        const tileDisabled = tile.key !== "chat" && dockState.disabled;
        const tileUnread = tile.key === "chat" && unread;
        return <motion.button key={tile.key} type="button"
          aria-label={tileUnread ? `${tile.name}, ${UNREAD_SUFFIX}` : tile.name}
          aria-current={tile.key === "chat" && live ? "page" : undefined}
          disabled={tileDisabled}
          onClick={() => {
            if (tile.key === "chat") chat();
            else if (tile.key === "weigh-in") openWeighIn();
            else pick(tile.key);
          }}
          // Grok audit 2026-10-02, finding 4: five tiles side by side with an icon and a label in a
          // row overflowed a 320-390 px phone. Stacking the label under the icon lets each tile keep
          // the full column width for its own text instead of splitting it with the glyph.
          className={`${styles.trayTile} tap flex min-h-11 flex-col items-center justify-center gap-1 disabled:opacity-40`}
          initial={false} animate={tray ? { scale: 1 } : { scale: 0.85 }}
          transition={reduce ? INSTANT : { ...PRESS, delay: tray ? 0.04 * index : 0 }}
          whileTap={reduce ? undefined : { scale: 0.92 }}>
          <span className="relative flex">
            <Icon size={20} strokeWidth={1.6} aria-hidden="true" />
            {tile.key === "chat" && <UnreadDot show={unread} className="absolute -right-1 -top-1" />}
          </span>
          <span className="whitespace-nowrap text-caption font-medium">{tile.label}</span>
        </motion.button>;
      })}
    </motion.div>

    <form role="search" aria-label={`Ask ${ASSISTANT_NAME}`} aria-current={live ? "page" : undefined}
      inert={!open} onSubmit={submit} onBlur={blurred}
      className="absolute inset-x-0 bottom-0 flex h-16 items-center pl-2.5 pr-2.5">
      {/* One glyph slot for both states: the closed bubble's mark becomes the + control. */}
      <button ref={attach} type="button" aria-label={tray ? "Hide attach options" : "Attach"} aria-expanded={tray}
        tabIndex={open ? 0 : -1} onClick={() => { setWeighing(false); setTrayFor((out) => !out); }}
        className={`${styles.tab} tap flex size-11 shrink-0 items-center justify-center rounded-full`}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={leading} className="flex"
            initial={reduce ? false : { opacity: 0, rotate: -90, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, rotate: 90, scale: 0.6, transition: { duration: 0.12 } }}
            transition={reduce ? INSTANT : PRESS}>
            {leading === "chat" ? <MessageCircle size={20} strokeWidth={1.6} aria-hidden="true" />
              : <Leading size={22} strokeWidth={1.6} aria-hidden="true" />}
          </motion.span>
        </AnimatePresence>
      </button>
      <motion.div className="relative flex min-w-0 flex-1 items-center" initial={false}
        animate={open ? { opacity: 1, x: 0 } : { opacity: 0, x: -8 }}
        transition={reduce ? INSTANT : open ? { ...FADE, delay: 0.12 } : { duration: 0.1 }}>
        <textarea ref={input} rows={1} maxLength={2000} autoComplete="off" enterKeyHint="send"
          role="searchbox" aria-label={`Ask ${ASSISTANT_NAME}`} disabled={dockState.disabled}
          // Grok audit 2026-10-02, finding 2: dictation wrote straight into the box without this,
          // so a stray keystroke mid-recording interleaved with the live transcript.
          readOnly={listening}
          placeholder={dockState.offline ? COMPOSER_OFFLINE_COPY : `Ask ${ASSISTANT_NAME}`}
          className={ASK_INPUT_CLASS}
          {...textEvents} onKeyDown={keyDown} />
      </motion.div>
      <AskPop show={open && hasText && !listening} popKey="clear" label="Clear text" onClick={clear}
        reduce={reduce}>
        <X size={16} strokeWidth={1.8} aria-hidden="true" />
      </AskPop>
      {/* Grok audit 2026-10-02, finding 1: a distinct Send beside Record, restored from the old
       *  composer (components/coach/Composer.tsx) — data-composer-action keeps a tap here from
       *  reading as "left the field" (use-composer-input's onBlur). */}
      <AskPop show={open && canSend} popKey="send-message" label="Send message" composerAction
        disabled={dockState.disabled} onClick={() => send(readBox())} reduce={reduce}>
        <Round><SendGlyph /></Round>
      </AskPop>
      <motion.div className={`${styles.micButton} flex size-11 shrink-0 items-center justify-center`} initial={false}
        animate={open ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }}
        transition={reduce ? INSTANT : open ? { ...PRESS, delay: 0.16 } : { duration: 0.1 }}>
        {/* Record while the caret sits at the draft's end (or the box is empty); Send once it
         *  doesn't, matching the distinct Send button above (useComposerInput's own readyToSend). */}
        <CoachMic {...micEvents} disabled={dockState.disabled}
          sendFeedbackState={dockState.sendFeedbackState}
          sendFeedbackClassName={dockState.sendFeedbackClassName} />
      </motion.div>
    </form>

    <AnimatePresence initial={false}>
      {!open && <motion.button key="ask" type="button" onClick={onOpen}
        aria-label={askName} title={askName}
        className={`${styles.tab} tap absolute inset-0 flex items-center justify-center rounded-full`}
        initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: reduce ? INSTANT : { duration: 0.08 } }}>
        {/* Over the speech bubble's upper right, where a phone's own badges sit. */}
        <UnreadDot show={unread} className="absolute right-4 top-4" />
      </motion.button>}
    </AnimatePresence>
    </div>
    {/* A sibling of the clipped card above (not nested inside it), so growing the attach tray never
        clips this popover; opens above the field, the same way it opened above the page's own
        composer. Closing the tray first (the tile's own handler) keeps the two from overlapping. */}
    {/* U19: it spans the whole dock row (the folded capsule and the field), so its follow-ups fit
        one line, and rises from the dock on the smooth spring. */}
    <AnimatePresence>
      {weighVisible && <motion.div key="weigh" className="absolute bottom-full right-0 z-10 mb-2"
        style={{ left: -(BUBBLE + SPLIT), transformOrigin: "50% 100%" }}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: 12, scale: 0.98 }}
        transition={spring("smooth", reduce)}>
        <WeighInField unit={weightUnit} disabled={dockState.disabled} value={weightDraft}
          onValueChange={setWeightDraft} onClose={closeWeighIn}
          onAsk={(text) => { setWeighing(false); submitText(text); }} />
      </motion.div>}
    </AnimatePresence>
    {/* Grok audit 2026-10-02, finding 2: a mic error (permission denied, no speech heard) never
     *  reached the dock at all. Rises above the field the same way the old composer's own line did
     *  (components/coach/Composer.tsx), one line, role="status" so it's announced without stealing
     *  focus. */}
    {micNotice && !weighVisible && <p role="status"
      className="absolute inset-x-0 bottom-full z-10 mb-2 px-3 text-center text-caption text-muted">
      {micNotice}
    </p>}
  </motion.div>;
}
