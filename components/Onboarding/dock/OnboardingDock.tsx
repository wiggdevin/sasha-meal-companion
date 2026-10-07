"use client";

import {
  useEffect, useLayoutEffect, useRef, useState,
  type FormEvent, type KeyboardEvent, type ReactNode,
} from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Mic } from "lucide-react";
import Button, { type ButtonStatus } from "@/components/ui/Button";
import { INSTANT, PRESS, lensVar, sheen, sheenOff } from "@/components/dock/dock-motion";
import { AskSkin, ASK_INPUT_CLASS } from "@/components/dock/AskShell";
import { SPRINGS } from "@/lib/design/motion";
import { ASSISTANT_NAME } from "@/lib/brand";
// Styles live in TabBar.module.css only (components/dock/AskShell.tsx) — the dock's one glass
// body is never redrawn in a second module; its own chip-surface rule (Sol round 3, below) is the
// one exception, since it is new presentation this lane owns, not a restyle of a shared class.
import styles from "@/components/TabBar.module.css";
import dockStyles from "./OnboardingDock.module.css";

/**
 * Onboarding v2's morphing dock (lane L2, 2026-10-07): one glass pill at the bottom of the
 * conversational shell that morphs its CONTENT between the beats the brief describes — never a
 * page transition, never a second dock.
 *
 * Dock-capability finding, reported to "main" within the first hour (see coord.md CONTRACT
 * ONB2-L2): the existing dock (`components/dock/AssistantField.tsx`) morphs between exactly two
 * shapes — a closed round bubble and an open text pill — plus one icon-grid tray above itself and
 * one side popover beside itself. It has no built-in "chip row" or "confirm button" content mode.
 * Those are new here, built ADDITIVELY on the dock's own primitives (`dock-motion.ts`'s named
 * springs, `lensVar`, `sheen`; `AskShell.tsx`'s glass skin, input class, round-press pattern) —
 * nothing in `components/dock/` itself was changed.
 *
 * The fourth beat, "game", is not literally the falling-food game rendered inside a 64–136px glass
 * bar — that content is a full-screen layer the page mounts above the dock (lane L4's territory).
 * In "game" mode the dock itself shows only the one escape action the brief calls for ("Sprout,
 * pick for me") so the bar never goes empty and dead while the game has the screen.
 *
 * GPT-6 Sol review (2026-10-07), fixed here: the frame height no longer comes from a fixed
 * per-mode table (a wrapped chip row at a narrow width or larger text could clip) — it is measured
 * from the mounted content and the frame springs to whatever that is. The outgoing mode's content is
 * also made `inert` and loses focus the moment it starts leaving, so a departing control is never
 * still tappable or focused underneath the one arriving.
 */
export type OnboardingDockMode = "mic" | "chips" | "game" | "confirm";

export type DockChip = { key: string; label: string; emphasis?: "default" | "largest" };

type Props = {
  mode: OnboardingDockMode;
  reduce: boolean;
  /** mic */
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  micLabel?: string;
  onMicTap?: () => void;
  listening?: boolean;
  placeholder?: string;
  /** chips */
  chips?: DockChip[];
  onPick?: (key: string) => void;
  /** game (escape chip only — the game itself renders above the dock, not inside it) */
  escapeLabel?: string;
  onEscape?: () => void;
  /** confirm */
  confirmLabel?: string;
  onConfirm?: () => void;
  confirmStatus?: ButtonStatus;
};

const MIN_HEIGHT = 64;

/**
 * VISUAL-SPEC.md §7's one container-choreography vocabulary (motion-craft physicality: never scale
 * from 0): generative containers — including each of the dock's own mode layers — enter
 * scale(0.94→1)+opacity over 240ms and leave scale(1→0.97)+opacity over 160ms (asymmetric: exit
 * shorter than enter), on the same ease-out curve already used for a Sprout pose cross-fade
 * (app/globals.css:501). A literal easing array here, not a house `SPRINGS` name, because this one
 * is motion-craft's own duration band, not the house spring system (VISUAL-SPEC.md references cited
 * in full at its top).
 */
const CONTAINER_EASE = [0.23, 1, 0.32, 1] as const;
const CONTAINER_ENTER = { duration: 0.24, ease: CONTAINER_EASE };
const CONTAINER_EXIT = { duration: 0.16, ease: CONTAINER_EASE };

function MicContent({ value, onChange, onSubmit, placeholder, micLabel, onMicTap, listening, reduce }: {
  value: string; onChange?: (v: string) => void; onSubmit?: (v: string) => void; placeholder?: string;
  micLabel: string; onMicTap?: () => void; listening?: boolean; reduce: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim()) onSubmit?.(value);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (value.trim()) onSubmit?.(value); }
  }
  const tellLabel = `Tell ${ASSISTANT_NAME}`;
  // Sol review: a search field announces as search, not as an answer to the assistant's own
  // question — this is a plain labelled form, not role="search"/"searchbox".
  return <form aria-label={tellLabel} onSubmit={submit} className="flex h-16 w-full items-center gap-1 px-2.5">
    <textarea ref={input} rows={1} maxLength={2000} autoComplete="off" enterKeyHint="send"
      aria-label={tellLabel} readOnly={listening} placeholder={placeholder}
      value={value} onChange={(event) => onChange?.(event.target.value)} onKeyDown={keyDown}
      className={ASK_INPUT_CLASS} />
    <motion.button type="button" aria-label={micLabel} aria-pressed={listening ?? false} onClick={onMicTap}
      className={`${styles.tab} tap flex size-11 shrink-0 items-center justify-center rounded-full`}
      whileTap={reduce ? undefined : { scale: 0.92 }} transition={reduce ? INSTANT : PRESS}>
      <Mic size={20} strokeWidth={1.8} aria-hidden="true" />
    </motion.button>
  </form>;
}

/**
 * VISUAL-SPEC.md §4: the dock's own `.tab` class (`rgb(226 220 208 / 0.6)`, built for a muted nav
 * glyph) read as low-contrast grey-on-black for a chip's own body text. A regular chip now gets a
 * real surface — a visible hairline and a faint tint, both via `--ink-rgb` (the `.matte` scope's own
 * token, never a hand-picked literal) — with its label in `text-charcoal`, which `.matte` already
 * remaps to cream. The one "largest"-emphasis chip per row (today: "No, nothing") reuses the real
 * `Button` primary recipe instead of a bespoke "selected" look.
 */
function ChipsContent({ chips, onPick, reduce }: { chips: DockChip[]; onPick?: (key: string) => void; reduce: boolean }) {
  return <div role="group" aria-label="Choose one" className="flex w-full flex-wrap items-center justify-center gap-2 p-3">
    {chips.map((chip, index) => {
      const delayed = { ...CONTAINER_ENTER, delay: Math.min(index, 5) * 0.03 };
      if (chip.emphasis === "largest") {
        return <motion.div key={chip.key} className="min-h-12 basis-full"
          initial={reduce ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}
          transition={reduce ? INSTANT : delayed}>
          <Button variant="primary" size="md" block onClick={() => onPick?.(chip.key)}>{chip.label}</Button>
        </motion.div>;
      }
      return <motion.button key={chip.key} type="button" onClick={() => onPick?.(chip.key)}
        className={`${dockStyles.chipSurface} tap min-h-11 rounded-full border px-4 text-body font-medium text-charcoal`}
        initial={reduce ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}
        transition={reduce ? INSTANT : delayed}
        whileTap={reduce ? undefined : { scale: 0.94 }}>
        {chip.label}
      </motion.button>;
    })}
  </div>;
}

function GameContent({ escapeLabel, onEscape, reduce }: { escapeLabel: string; onEscape?: () => void; reduce: boolean }) {
  // Same contrast fix as a regular chip (§4) — this is a labelled escape action, not a muted glyph.
  return <div className="flex h-16 w-full items-center justify-center px-3">
    <motion.button type="button" onClick={onEscape}
      className={`${dockStyles.chipSurface} tap min-h-11 rounded-full border px-4 text-body font-medium text-charcoal`}
      whileTap={reduce ? undefined : { scale: 0.94 }} transition={reduce ? INSTANT : PRESS}>
      {escapeLabel}
    </motion.button>
  </div>;
}

function ConfirmContent({ confirmLabel, onConfirm, confirmStatus }: {
  confirmLabel: string; onConfirm?: () => void; confirmStatus?: ButtonStatus;
}) {
  return <div className="flex h-16 w-full items-center justify-center px-3">
    <Button variant="primary" size="lg" block status={confirmStatus} onClick={onConfirm}
      data-feedback-state={confirmStatus}>
      {confirmLabel}
    </Button>
  </div>;
}

/** Mode content as one node; kept as a function (not a lookup table of elements) so each mode
 *  only reads the props it actually uses. */
function modeContent(mode: OnboardingDockMode, props: Props, reduce: boolean): ReactNode {
  if (mode === "mic") return <MicContent value={props.value ?? ""} onChange={props.onChange}
    onSubmit={props.onSubmit} placeholder={props.placeholder} micLabel={props.micLabel ?? "Record"}
    onMicTap={props.onMicTap} listening={props.listening} reduce={reduce} />;
  if (mode === "chips") return <ChipsContent chips={props.chips ?? []} onPick={props.onPick} reduce={reduce} />;
  if (mode === "game") return <GameContent escapeLabel={props.escapeLabel ?? "Sprout, pick for me"}
    onEscape={props.onEscape} reduce={reduce} />;
  return <ConfirmContent confirmLabel={props.confirmLabel ?? "That's me"} onConfirm={props.onConfirm}
    confirmStatus={props.confirmStatus} />;
}

/**
 * One keyed mode's layer: measures its own content so the frame can size to it, and — while it is
 * the one LEAVING — goes `inert` and gives up focus at once, so a departing chip or button is never
 * still reachable or tappable underneath the mode arriving over it (Sol review).
 */
function ModeLayer({ mode, props, reduce, onMeasure }: {
  mode: OnboardingDockMode; props: Props; reduce: boolean; onMeasure: (height: number) => void;
}) {
  const present = useIsPresent();
  const self = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!present || !self.current) return;
    const el = self.current;
    const report = () => onMeasure(el.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onMeasure is a stable setter
  }, [present]);

  useEffect(() => {
    if (present) return;
    if (self.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
  }, [present]);

  return <motion.div ref={self} inert={!present} aria-hidden={present ? undefined : true}
    data-dock-live={present || undefined}
    className="absolute inset-x-0 top-0 flex w-full items-center justify-center"
    initial={reduce ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}
    exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.97, transition: CONTAINER_EXIT }}
    transition={reduce ? INSTANT : CONTAINER_ENTER}>
    {modeContent(mode, props, reduce)}
  </motion.div>;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function OnboardingDock(props: Props) {
  const { mode, reduce } = props;
  const [height, setHeight] = useState(MIN_HEIGHT);
  const glass = useRef<HTMLDivElement | null>(null);
  const hadFocus = useRef(false);

  // Sol review round 3: the outgoing layer already blurs itself on exit (ModeLayer, above), but
  // nothing took the keyboard's place — after a keyboard goal pick, the next Tab started over from
  // the document instead of landing on the control that just arrived. If the dock held focus right
  // before `mode` changes, the arriving layer's own first control claims it once mounted.
  useEffect(() => {
    const el = glass.current;
    if (!el) return;
    const onFocusIn = () => { hadFocus.current = true; };
    const onFocusOut = (event: FocusEvent) => {
      if (!event.relatedTarget || !el.contains(event.relatedTarget as Node)) hadFocus.current = false;
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => { el.removeEventListener("focusin", onFocusIn); el.removeEventListener("focusout", onFocusOut); };
  }, []);

  // A layout effect, not a passive one: every `useLayoutEffect` in the tree runs (bottom-up) before
  // any `useEffect` does, so this runs before the outgoing `ModeLayer`'s own blur-on-leave effect
  // (a passive `useEffect`) gets a chance to fire its own blur/focusout and — by bubbling to the
  // `focusout` listener above — overwrite `hadFocus.current` with a false reading of "focus left the
  // dock" before this ever reads it. Setting focus here first also means that blur-on-leave check
  // (`self.current?.contains(document.activeElement)`) is already false by the time it runs, so it
  // leaves the newly-focused control alone.
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    glass.current?.querySelector<HTMLElement>(`[data-dock-live] ${FOCUSABLE}`)?.focus();
  }, [mode]);

  return <motion.div data-onboarding-dock="true" data-mode={mode} className={`${dockStyles.dockFrame} relative w-full`}
    style={{ borderRadius: 32, ...lensVar("pill") }}
    initial={false} animate={{ height: Math.max(MIN_HEIGHT, height) }}
    transition={reduce ? INSTANT : SPRINGS.gentle}
    onPointerMove={sheen} onPointerLeave={sheenOff}>
    <div ref={glass} className={`${styles.glass} ${styles.assistant} matte absolute inset-0 overflow-hidden`}
      style={{ borderRadius: 32 }}>
      <AskSkin reduce={reduce} />
      <AnimatePresence initial={false}>
        <ModeLayer key={mode} mode={mode} props={props} reduce={reduce}
          onMeasure={(measured) => setHeight((current) => (current === measured ? current : measured))} />
      </AnimatePresence>
    </div>
  </motion.div>;
}
