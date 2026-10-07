"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { ActionFeedbackPhase } from "@/components/ui/ActionFeedback";

export const COACH_DOCK_STATE_EVENT = "coach:dock-state";

export type DockComposerState = {
  disabled: boolean; scanDisabled: boolean; offline: boolean;
  /** A coach turn is in flight: the field shows the assistant thinking where its placeholder sits. */
  thinking?: boolean;
  /** The in-flight turn's own pending/success glow (`useSendFeedback`): the page composer had a
   *  separate Send button to carry it; the dock's one control (CoachMic) carries it itself. */
  sendFeedbackState?: ActionFeedbackPhase;
  sendFeedbackClassName?: string;
};

const IDLE: DockComposerState = { disabled: false, scanDisabled: false, offline: false };

/**
 * The dock's ask field (TabBar/AssistantField) is mounted outside the coach page's own tree
 * (AppChrome, beside it), so it cannot read CoachShell's state directly. CoachShell broadcasts its
 * composer-disabled state here; the field reads it only while the user is on /coach, the same way
 * the removed page composer was disabled (module state + a window event, the pattern already used
 * by use-dock-submit.ts and dock-handoff.tsx for the reverse direction).
 */
let latest: DockComposerState = IDLE;

export function useBroadcastDockComposerState(state: DockComposerState): void {
  useEffect(() => {
    latest = state;
    window.dispatchEvent(new CustomEvent(COACH_DOCK_STATE_EVENT, { detail: state }));
    return () => {
      latest = IDLE;
      window.dispatchEvent(new CustomEvent(COACH_DOCK_STATE_EVENT, { detail: IDLE }));
    };
    // state is a fresh object each render; the fields are what actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.disabled, state.scanDisabled, state.offline, state.thinking, state.sendFeedbackState,
    state.sendFeedbackClassName]);
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(COACH_DOCK_STATE_EVENT, onStoreChange);
  return () => window.removeEventListener(COACH_DOCK_STATE_EVENT, onStoreChange);
}

function getSnapshot(): DockComposerState {
  return latest;
}

/** `active` is `onCoach`: away from /coach the field is never disabled by the coach's own state.
 *  The server renders no coach state at all (CoachShell is a client tree), so its snapshot is
 *  always idle; the phone answers for itself once it has mounted and heard a broadcast. */
export function useDockComposerState(active: boolean): DockComposerState {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
  return active ? state : IDLE;
}
