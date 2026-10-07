"use client";
/**
 * Input tier 2, the component ask box (DESIGN.md §Text fields, 2026-10-04): a paper pill with the
 * AI's thin olive → sage → wheat rim (no spark logo, owner 2026-10-04), one "+" on the left and the olive
 * Send circle. It reads as the AI's own field, close to a lookup field (tier 1) and distinct from
 * it, and a step quieter than the dock's charcoal bar (tier 3). What a photo is (a plate, a menu, a
 * fridge or a dish) is decided on the server.
 *
 * "+" grows a tab out of the pill's top edge on the left, just above and right of "+", one
 * continuous piece of the same material, its rim included (composer/ComposerShape.tsx,
 * composer/tab-shape.ts). The tab holds bare glyphs, no backing (2026-10-04, owner: "get rid of the
 * little button behind them, so it's just the icon"): attach nearest "×", then "Take a photo" (the
 * rear camera, straight away), each centred in its own half of the tab. Focus runs "+" → attach →
 * camera → the words. "+" turns to "×" while the tab is out; "×", a chosen file, Escape or a tap
 * outside the box puts it away on the same spring in reverse.
 *
 * What attach opens: with `onDocument`, the document picker (a meal plan, recipe or menu as a photo,
 * PDF or text file; lib/plan/document-files.ts) feeding `onDocument`; without it, the photo library
 * feeding `onPhoto`. With `cameraFirst` (log mode) the big camera button above the box is the photo
 * way in, so the tab holds attach alone rather than a second camera a thumb's width away.
 *
 * `upload` is kept for callers (the Foods recipe widget): the tab always offers a rear camera and a
 * library picker now, which is what it used to switch on.
 */
import { useId, useRef, type ChangeEvent, type MouseEvent, type ReactNode } from "react";
import { AnimatePresence, useReducedMotion, motion } from "motion/react";
import { PRESS, INSTANT } from "@/components/dock/dock-motion";
import { DOCUMENT_ACCEPT } from "@/lib/plan/document-files";
import Button from "@/components/ui/Button";
import { CameraIcon, PaperclipIcon, PlusIcon } from "@/components/ui/icons";
import ComposerShape from "@/components/plan/composer/ComposerShape";
import { PILL_HEIGHT, TAB_GLYPH, plateauWidth, tabBox } from "@/components/plan/composer/tab-shape";
import { useAttachTab, useBoxSize } from "@/components/plan/composer/useAttachTab";
import styles from "@/components/plan/PlanComposer.module.css";

const SendIcon = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  <path d="M12 19V5m-6 6 6-6 6 6" /></svg>;

export const PLAN_HINT = "Snap your plate to log it, or a menu and I’ll pick for you.";

/** "+"'s name, and the tab's. */
export const ATTACH_LABEL = "Add a photo or file";

/** Under reduced motion the tab's glyphs fade rather than pop. */
const REDUCED_FADE = { duration: 0.2, ease: "easeOut" } as const;

type Picker = "camera" | "upload" | "document";
type TabAction = { key: Picker; label: string; icon: ReactNode };

export default function PlanComposer({ draft, onDraft, onSubmit, onPhoto, onDocument, busy, label = "Ask for a meal idea",
  placeholder = "Try “healthy tacos”", hint = PLAN_HINT, cameraFirst, upload: _upload = false, photoNotice }: {
  draft: string; onDraft: (value: string) => void; onSubmit: () => void; onPhoto: (file: File) => void;
  /** A meal plan, recipe or menu file from the tab's attach button (images, PDF, .txt, .csv). */
  onDocument?: (file: File) => void;
  busy: boolean; label?: string; placeholder?: string; hint?: string;
  /** Log mode: a full-width camera button leads, above the box. */
  cameraFirst?: string;
  /** Kept for callers; the tab always has a rear camera and a library picker (see the file note). */
  upload?: boolean;
  /** Present beside the box, before any tap opens the camera or file picker — never a dialog
   *  (Phase 18 W12-F). Only the callers whose photo reaches a model pass this. */
  photoNotice?: ReactNode;
}) {
  const reduce = !!useReducedMotion();
  const form = useRef<HTMLFormElement>(null);
  const { open, toggleRef, toggle, close, onKeyDown } = useAttachTab(form);
  const size = useBoxSize(form);
  const tabId = useId();
  const cameraInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);

  /** A chosen file puts the tab away (focus back on "+") and goes to its handler, as before. */
  const take = (handle: (file: File) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (open) close(true);
    handle(file);
  };
  const picked = take(onPhoto);
  // The picker must open inside this tap: iOS ignores a file-input click outside a gesture.
  function openPicker(event: MouseEvent<HTMLButtonElement>) {
    const key = event.currentTarget.dataset.picker as Picker;
    (key === "camera" ? cameraInput : key === "upload" ? uploadInput : documentInput).current?.click();
  }

  const actions: TabAction[] = [
    onDocument
      ? { key: "document", label: "Upload a meal plan or document", icon: <PaperclipIcon size={TAB_GLYPH} /> }
      : { key: "upload", label: "Upload a photo", icon: <PaperclipIcon size={TAB_GLYPH} /> },
    ...(cameraFirst ? [] : [{ key: "camera" as const, label: "Take a photo", icon: <CameraIcon size={TAB_GLYPH} /> }]),
  ];
  const plateau = plateauWidth(actions.length);
  const height = size.height || PILL_HEIGHT;
  const box = tabBox(height, actions.length);
  const shaped = size.width > 0;
  const ready = !busy && draft.trim().length > 0;

  return <div className="flex min-w-0 flex-col gap-2">
    {cameraFirst && <Button variant="primary" size="lg" block disabled={busy} leading={<CameraIcon size={20} />}
      onClick={() => cameraInput.current?.click()}>{cameraFirst}</Button>}
    {/* mt-6 keeps most of the tab's 30 px of room above the pill; the gap above gives the rest, so
        the open tab never covers what sits above the box. */}
    <form ref={form} aria-label={label} onKeyDown={onKeyDown}
      className={`plan-ask ${styles.form} ${shaped ? styles.shaped : ""} mt-6 flex min-h-14 min-w-0 items-center gap-1 pl-1.5 pr-1.5`}
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {shaped && <ComposerShape width={size.width} height={size.height} plateau={plateau} open={open}
        reduce={reduce} />}
      <Button ref={toggleRef} variant="ghost" shape="circle" aria-label={ATTACH_LABEL} aria-expanded={open}
        aria-controls={tabId} disabled={busy} onClick={toggle} className="text-graphite">
        {/* "+" turns 45° into "×". */}
        <motion.span className="flex" initial={false} animate={{ rotate: open ? 45 : 0 }}
          transition={reduce ? INSTANT : PRESS}>
          <PlusIcon size={20} />
        </motion.span>
      </Button>
      <div id={tabId} role="group" aria-label={ATTACH_LABEL} inert={!open} data-open={open || undefined}
        className={styles.tab} style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        <AnimatePresence initial={false}>
          {open && actions.map((action, index) => <motion.button key={action.key} type="button"
            aria-label={action.label} disabled={busy} data-picker={action.key} onClick={openPicker}
            className={styles.tabButton}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0, transition: REDUCED_FADE }
              : { opacity: 0, scale: 0.6, y: 8, transition: { duration: 0.1 } }}
            transition={reduce ? REDUCED_FADE : { ...PRESS, delay: 0.06 + 0.04 * index }}
            whileTap={reduce ? undefined : { scale: 0.9 }}>
            {action.icon}
          </motion.button>)}
        </AnimatePresence>
      </div>
      {/* Tier 2 reads as the AI's field by its rim alone; no spark logo in any chat (owner, 2026-10-04). */}
      <input aria-label={label} value={draft} maxLength={500} enterKeyHint="send" autoComplete="off"
        onChange={(event) => onDraft(event.target.value)} placeholder={placeholder}
        className="min-h-11 min-w-0 flex-1 bg-transparent pl-3 text-body-md text-charcoal outline-none placeholder:text-muted" />
      {/* Send waits, a little smaller and dimmed, until there are words; then it springs up. */}
      <motion.span className="flex shrink-0" initial={false} animate={{ scale: ready ? 1 : 0.86 }}
        whileTap={reduce || !ready ? undefined : { scale: 0.92 }} transition={reduce ? INSTANT : PRESS}>
        <Button type="submit" variant="primary" shape="circle" aria-label="Send" disabled={!ready}>
          <SendIcon />
        </Button>
      </motion.span>
      {/* The camera input: no `capture`, so the phone offers Take Photo or the photo library, and a
          plate photo already in the library still reads as a plate (attach goes to the document reader). */}
      <input ref={cameraInput} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1}
        data-photo-input="camera" onChange={picked} />
      {!onDocument && <input ref={uploadInput} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1}
        data-photo-input="upload" onChange={picked} />}
      {onDocument && <input ref={documentInput} type="file" accept={DOCUMENT_ACCEPT} hidden aria-hidden="true"
        tabIndex={-1} data-photo-input="document" onChange={take(onDocument)} />}
    </form>
    <p className="m-0 px-1 text-tiny text-muted">{hint}</p>
    {photoNotice}
  </div>;
}
