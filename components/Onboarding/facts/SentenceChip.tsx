"use client";

/**
 * Onboarding v2, lane 3 — one inline chip inside the playback sentence (BRIEF.md §4: "a hold on
 * any inline chip opens that one field for edit"). One control, three uses:
 *
 * - An empty slot: its one action opens the picker for that field (BRIEF §4: "gaps point, they
 *   don't ask" — no new extraction call, just a single-value picker).
 * - A ghost (low/mid-confidence) chip: its one action confirms the field; holding instead opens
 *   the editor, for a user who wants to fix it rather than accept it.
 * - A confirmed (high-confidence) value: its one action opens the editor — there is nothing left
 *   to *confirm*, so edit is the only thing left for it to do.
 *
 * Sol r3 re-plan (coord.md, after r1 and r2 each found a fresh keyboard/assistive-tech gap in a
 * hand-rolled pointer+key activation path): activation is now built on the browser's own `click`
 * event, not three parallel pointer/key paths that each needed their own completeness proof.
 * `onActivate` is the chip's one required action; the native `<button>`'s `onClick` fires it for
 * a real pointer tap, Enter/Space (the browser's own default button behavior — no custom
 * `onKeyDown` needed), AND an assistive-tech-dispatched synthetic click, all for free, all through
 * one code path. Pointer events exist only to detect an optional hold: on a ghost chip, holding
 * past `HOLD_MS` fires `onHoldEdit` (the "fix it instead of confirming" escape hatch) and arms a
 * one-shot flag that swallows the `click` the browser still fires after the pointer lifts — so a
 * hold never *also* confirms. Nothing fires on pointer-down itself, and leaving the chip before
 * the threshold cancels the hold cleanly, including disarming that flag.
 *
 * Sol r4 BLOCK fix: `onPointerLeave` used to unconditionally reset the "a hold already fired"
 * flag, so a completed hold (editor already opened) followed by leave → return → release could
 * fire `onActivate` too — the click-suppression the file doc above promises only held for a
 * leave-free release. `holdFired` is now only reset when the leave is actually cancelling a
 * still-pending timer (`timer.current !== null`); once a hold has fired, the timer is already
 * spent, so a later leave cannot un-arm the suppression.
 *
 * Sol r5 WARN fix: `onPointerCancel` used to share that same leave handler, so it inherited the
 * "keep the suppression armed" rule too — but `pointercancel` is a different, stronger signal
 * than `pointerleave`: the browser is telling this element its press sequence is void and
 * guarantees no `click` will follow it at all. Leaving `holdFired` armed after a genuine cancel
 * would silently swallow the NEXT, unrelated activation (a keyboard press or assistive-tech click
 * with no pointer sequence of its own). `onPointerCancel` now always fully resets, unconditionally.
 */
import { useRef, useState } from "react";
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";

const HOLD_MS = 500;

export type ChipKind = "value" | "ghost" | "empty";

export function SentenceChip({
  kind,
  label,
  ariaLabel,
  onActivate,
  onHoldEdit,
}: {
  kind: ChipKind;
  label: string;
  ariaLabel?: string;
  /** The chip's one primary action: empty opens its picker, ghost confirms, value opens its
   *  editor. Fired by click — pointer tap, Enter/Space, or any synthetic click alike. */
  onActivate: () => void;
  /** Pointer-hold alternative, ghost chips only ("fix it" instead of confirming). Never fires
   *  from a keyboard press — holding a key is not a gesture this chip recognizes. */
  onHoldEdit?: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const holdFired = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimer() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function onPointerDown() {
    if (!onHoldEdit) return;
    holdFired.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      holdFired.current = true;
      setHolding(false);
      onHoldEdit();
    }, HOLD_MS);
  }

  function onPointerUp() {
    // The hold either already fired (its timer is spent, timer.current is already null) or
    // didn't (clear its pending timer here); either way, nothing more to start — the browser's
    // own `click` event, not this handler, drives the tap outcome.
    clearTimer();
    setHolding(false);
  }

  function onPointerLeave() {
    // Only un-arm a still-PENDING hold attempt. If the hold already fired, `timer.current` is
    // already null (cleared in the timeout itself, above) and `holdFired` must stay true — a
    // leave after a completed hold must not let a later click slip through unsuppressed (that
    // click still comes, since a leave alone doesn't end the gesture).
    if (timer.current !== null) {
      clearTimer();
      holdFired.current = false;
    }
    setHolding(false);
  }

  function onPointerCancel() {
    // Unlike a leave, a cancel ends the gesture outright and guarantees no click follows it — so
    // nothing is left to suppress. Always reset fully, whether or not a hold had already fired.
    clearTimer();
    setHolding(false);
    holdFired.current = false;
  }

  function onClick() {
    // A hold already acted (onHoldEdit ran); swallow the click the browser still fires after the
    // pointer lifts, so a hold is never also read as a tap.
    if (holdFired.current) {
      holdFired.current = false;
      return;
    }
    onActivate();
  }

  // VISUAL-SPEC.md §5: a gap chip (empty or ghost — nothing resolved yet) is a dashed hairline
  // pill in text-muted; a filled chip (a confirmed value) is the solid tertiary pill (CHIP_FILL's
  // beige fill, DESIGN.md "tertiary actions are beige") with the resolved value in text-charcoal.
  const toneClass = kind === "value"
    ? "text-charcoal"
    : "border border-dashed border-muted text-muted";

  return (
    <button
      type="button"
      data-chip-kind={kind}
      data-holding={holding || undefined}
      aria-label={ariaLabel ?? label}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      className={`${CHIP_FILL} inline-flex min-h-8 items-center rounded-full px-2.5 text-label-md transition-opacity ${toneClass} ${holding ? "opacity-70" : ""}`}
    >
      {label}
    </button>
  );
}
