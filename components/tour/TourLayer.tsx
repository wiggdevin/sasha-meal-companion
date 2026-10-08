"use client";

import { Component, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, MotionConfig } from "motion/react";
import AppTour, { type TourCloseReason } from "@/components/tour/AppTour";
import { useMascot } from "@/components/today/island/well-pet";

/** An overview that fails to draw closes itself: the screen under it carries on. */
class TourBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.warn("[tour] the overview failed to draw and was skipped", error);
    this.props.onError();
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export type TourOpening = { origin: DOMRect | null; returnFocusTo: HTMLElement | null; seq: number };

/**
 * Where the overview lives while it is open: over everything (a portal to the body), under the
 * user's reduced-motion setting, inside an error boundary. Closing plays the sheet's fold back into
 * where it came from before it unmounts.
 */
export default function TourLayer({ opening, onClose }: {
  opening: TourOpening | null;
  onClose: (reason: TourCloseReason | "error") => void;
}) {
  const mascot = useMascot();
  if (typeof document === "undefined") return null;
  return createPortal(<MotionConfig reducedMotion="user">
    <AnimatePresence>
      {opening && <TourBoundary key={opening.seq} onError={() => onClose("error")}>
        <AppTour origin={opening.origin} returnFocusTo={opening.returnFocusTo} mascot={mascot} onClose={onClose} />
      </TourBoundary>}
    </AnimatePresence>
  </MotionConfig>, document.body);
}
