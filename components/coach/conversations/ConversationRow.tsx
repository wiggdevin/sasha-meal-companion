"use client";

/**
 * One saved chat in the Conversations list (U20, 2026-10-04). A tap opens it. Swiping it left
 * uncovers Delete; the "…" button opens the same actions in a row under it (Rename, Clear messages,
 * Delete) for a tap or the keyboard. Delete and Clear are permanent on the server, so each asks
 * twice inside its own button ("Delete" → "Delete for good"), and nothing offers an undo.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import Button from "@/components/ui/Button";
import Fold from "@/components/ui/Fold";
import { useButtonStatus } from "@/components/ui/useButtonStatus";
import { SPRINGS } from "@/lib/design/motion";
import { TITLE_MAX } from "@/lib/coach/threads-client";
import type { ThreadSummary } from "@/lib/coach-client";
import { titleOf } from "@/components/coach/conversations/list";
import UnreadDot from "@/components/ui/UnreadDot";
import styles from "./Conversations.module.css";

/** How far a swipe opens the row: room for "Delete for good". */
export const REVEAL_PX = 148;
/** An armed two-step button disarms itself if the second tap does not come. */
const DISARM_MS = 6000;

export type RowActions = {
  onDelete: () => Promise<void>;
  onClear: () => Promise<void>;
  onRename: (title: string) => Promise<void>;
};

/** A destructive button that asks twice in place: the first tap arms it, the second runs it. */
export function TwoStepButton({ label, armedLabel, doneLabel, run, disabled, size = "sm" }: {
  label: string; armedLabel: string; doneLabel: string; run: () => Promise<void>; disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [armed, setArmed] = useState(false);
  const status = useButtonStatus();
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return <Button variant="danger" size={size} disabled={disabled} status={status.status}
    data-armed={armed ? "true" : undefined} errorLabel="Try again" confirmLabel={doneLabel}
    aria-label={armed ? armedLabel : label} onBlur={() => setArmed(false)}
    onClick={() => {
      if (!armed) { setArmed(true); return; }
      setArmed(false);
      void status.run(run);
    }}>
    <span className={styles.twoStep}>
      <span data-shown={!armed}>{label}</span>
      <span data-shown={armed} aria-hidden={!armed}>{armedLabel}</span>
    </span>
  </Button>;
}

function RenameForm({ initial, onSave, onCancel }: {
  initial: string; onSave: (title: string) => Promise<void>; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const save = useButtonStatus();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    // The sheet closes on Escape too; this one only ends the rename.
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  const trimmed = value.trim();
  return <form className={styles.rename} onSubmit={(event) => {
    event.preventDefault();
    if (!trimmed) return;
    void save.run(() => onSave(trimmed)).then((result) => { if (result.ok) onCancel(); });
  }}>
    <div className="field">
      <input ref={field} className="field-input" aria-label="Chat name" value={value} maxLength={TITLE_MAX}
        enterKeyHint="done" autoComplete="off" onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown} />
    </div>
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!trimmed} status={save.status}
        confirmLabel="Saved">Save</Button>
    </div>
  </form>;
}

export default function ConversationRow({ thread, time, current, disabled, manageable, snippet, onOpen, actions,
  unread = false }: {
  thread: ThreadSummary;
  time: string;
  current: boolean;
  /** No opening while a reply is finishing or the list is refreshing. */
  disabled: boolean;
  /** Delete, clear and rename are offered (not while this chat's reply is in flight). */
  manageable: boolean;
  snippet?: ReactNode;
  onOpen: () => void;
  /** Absent for a thread the server owns (the weekly review): no swipe, no "…" menu. */
  actions?: RowActions;
  /** Not opened since something arrived in it (a delivered weekly review): a dot, and "New" in its name. */
  unread?: boolean;
}) {
  const reduce = useReducedMotion();
  const title = titleOf(thread);
  const x = useMotionValue(0);
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const settle = (open: boolean) => {
    setRevealed(open);
    animate(x, open ? -REVEAL_PX : 0, reduce ? { duration: 0 } : SPRINGS.snappy);
  };
  // A swipe ends on the row's own button; the click that follows it must not open the chat.
  const dragged = useRef(false);
  const dragEnd = (_: unknown, info: PanInfo) => {
    settle(x.get() < -REVEAL_PX / 2 || info.velocity.x < -400);
    setTimeout(() => { dragged.current = false; }, 0);
  };

  if (renaming && actions) {
    return <div className={styles.row}>
      <RenameForm initial={thread.title ?? ""} onSave={actions.onRename} onCancel={() => setRenaming(false)} />
    </div>;
  }
  return <>
    <div className={styles.row}>
      {actions && <div className={styles.behind} style={{ width: REVEAL_PX }} inert={!revealed}>
        <TwoStepButton label="Delete" armedLabel="Delete for good" doneLabel="Deleted" run={actions.onDelete}
          disabled={!manageable} />
      </div>}
      <motion.div className={styles.face} style={{ x }} data-current={current ? "true" : undefined}
        data-unread={unread ? "true" : undefined}
        drag={manageable && actions ? "x" : false} dragDirectionLock dragMomentum={false} dragElastic={0.08}
        dragConstraints={{ left: -REVEAL_PX, right: 0 }} onDragStart={() => { dragged.current = true; }}
        onDragEnd={dragEnd}>
        <button type="button" className={`tap ${styles.open}`} disabled={disabled}
          aria-current={current ? "true" : undefined}
          onClick={() => { if (dragged.current) return; if (revealed) settle(false); else onOpen(); }}>
          <span className={styles.line}>
            <UnreadDot show={unread} className={styles.unread} />
            {unread && <span className="sr-only">New: </span>}
            <span className={`${styles.title} text-caption font-medium`}>{title}</span>
            <span className={`${styles.time} text-tiny`}>{time}</span>
          </span>
          {snippet && <span className={`${styles.snippet} text-tiny`}>{snippet}</span>}
        </button>
        {actions && <Button variant="ghost" shape="circle" aria-label={`More for ${title}`} aria-expanded={menu}
          disabled={!manageable} onClick={() => { settle(false); setMenu((open) => !open); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </Button>}
      </motion.div>
    </div>
    <AnimatePresence initial={false}>
      {menu && actions && <Fold key="menu">
        <div className={styles.menu} role="group" aria-label={`Actions for ${title}`}>
          <Button variant="secondary" size="sm" onClick={() => { setMenu(false); setRenaming(true); }}>Rename</Button>
          <TwoStepButton label="Clear messages" armedLabel="Clear for good" doneLabel="Cleared" run={actions.onClear} />
          <TwoStepButton label="Delete" armedLabel="Delete for good" doneLabel="Deleted" run={actions.onDelete} />
        </div>
      </Fold>}
    </AnimatePresence>
  </>;
}
