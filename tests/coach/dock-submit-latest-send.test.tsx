// @vitest-environment jsdom
// CI on PRs #65 and #70: "shows the existing honest network error when a turn fails" found no
// error copy after 3 s. The shell's restore settles outside act(), so React commits the new DOM
// (the "Loading saved messages…" line gone) and only later flushes the passive effect that
// re-registered the dock listener with the new `send`. Text dispatched in that gap reached the
// stale `send`, which still saw `restoring` and dropped it. The listener must always call the
// `send` of the last committed render.
import { createElement, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COACH_DOCK_SUBMIT_EVENT, useCoachDockSubmit } from "@/components/coach/use-dock-submit";

type Detail = { text: string; accepted: boolean; received?: boolean };

// A layout effect runs inside the commit, after the DOM changed and before any passive effect:
// the window in which the test's dispatch landed under CI load.
function Probe({ send, onCommit }: { send: (text: string) => boolean; onCommit?: () => void }) {
  useCoachDockSubmit(send, false);
  useLayoutEffect(() => { onCommit?.(); });
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function dispatch(text: string): Detail {
  const detail: Detail = { text, accepted: true };
  window.dispatchEvent(new CustomEvent(COACH_DOCK_SUBMIT_EVENT, { detail }));
  return detail;
}

describe("the dock listener", () => {
  it("calls the send of the last committed render, before passive effects flush", () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      const restoring = vi.fn(() => false);
      const ready = vi.fn(() => true);
      flushSync(() => root!.render(createElement(Probe, { send: restoring })));
      // Let the first mount's passive effects run, so a listener is registered.
      flushSync(() => undefined);
      dispatch("warm up");
      restoring.mockClear();

      // The restore finishes and commits; the text arrives before passive effects run.
      let detail: Detail | null = null;
      flushSync(() => root!.render(createElement(Probe, {
        send: ready, onCommit: () => { detail ??= dispatch("Hello"); },
      })));

      expect(restoring).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledWith("Hello");
      expect(detail).toMatchObject({ received: true, accepted: true });
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
});
