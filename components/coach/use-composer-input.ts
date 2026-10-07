"use client";

import { useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Record sits beside Send only while the caret is collapsed at the end of the draft, where a
 * dictation would append. A caret or selection inside the draft leaves Send alone. No reported
 * caret keeps Record: the rule hides a control only on positive evidence.
 */
export function canShowRecord(draft: string, selectionStart: number | null, selectionEnd: number | null): boolean {
  if (!draft || selectionStart === null || selectionEnd === null) return true;
  return selectionStart === selectionEnd && selectionEnd === draft.length;
}

export function useComposerInput(disabled: boolean, onSend: (text: string) => void | boolean) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const recordPointerDown = useRef(false);
  const cancelledPointerClick = useRef(false);
  const wasListening = useRef(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [listening, setListening] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const [micNotice, setMicNotice] = useState<string | null>(null);

  const send = (text: string) => {
    if (!text.trim() || disabled || listening || reviewNeeded) return;
    if (onSend(text) !== false && input.current) {
      input.current.value = "";
      setDraft("");
      setEditing(false);
      setCaretAtEnd(true);
    }
  };
  const readBox = () => input.current?.value ?? "";
  // Positioning only: these handlers read the caret and never submit.
  const readCaret = (event: { currentTarget: HTMLTextAreaElement }) => {
    const box = event.currentTarget;
    setEditing(true);
    setCaretAtEnd(canShowRecord(box.value, box.selectionStart, box.selectionEnd));
  };
  const textEvents = {
    onChange: (event: { currentTarget: HTMLTextAreaElement }) => {
      setDraft(event.currentTarget.value);
      readCaret(event);
    },
    onFocus: readCaret,
    onClick: readCaret,
    onSelect: readCaret,
    onKeyUp: readCaret,
    onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
      const toAction = (event.relatedTarget as HTMLElement | null)
        ?.closest?.("[data-composer-action]");
      if (!recordPointerDown.current && !toAction) setEditing(false);
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !composing.current
        && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        send(event.currentTarget.value);
      }
    },
  };
  const micEvents = {
    readBox,
    writeBox: (text: string) => {
      if (input.current) input.current.value = text;
      setDraft(text);
      setCaretAtEnd(true);
    },
    onSend: send,
    reviewNeeded,
    onReviewNeeded: (needed: boolean) => {
      setReviewNeeded(needed);
      if (!needed) setEditing(false);
    },
    // Outside editing, or with the caret inside the draft, the one main control is Send.
    readyToSend: Boolean(draft.trim()) && (!editing || !caretAtEnd),
    onRecordPointerDown: () => {
      cancelledPointerClick.current = false;
      recordPointerDown.current = true;
    },
    onRecordPointerDone: () => {
      recordPointerDown.current = false;
      cancelledPointerClick.current = true;
    },
    onActionStart: () => { cancelledPointerClick.current = false; },
    onActionClick: (detail: number) => {
      recordPointerDown.current = false;
      const cancelled = cancelledPointerClick.current;
      cancelledPointerClick.current = false;
      return cancelled && detail > 0;
    },
    onActionPointerUp: (event: PointerEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right
        || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) {
        recordPointerDown.current = false;
        cancelledPointerClick.current = true;
      }
      return outside;
    },
    onListening: (locked: boolean) => {
      setListening(locked);
      if (wasListening.current && !locked) setEditing(false);
      wasListening.current = locked;
    },
    onNotice: setMicNotice,
  };
  return { input, draft, editing, caretAtEnd, listening, reviewNeeded, micNotice, readBox, send, textEvents, micEvents };
}
