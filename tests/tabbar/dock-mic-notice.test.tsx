// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabBar from "@/components/TabBar";
import { PERMISSION_COPY } from "@/lib/coach/dictation";
import type { SpeechHandlers } from "@/lib/coach/speech-api";

/**
 * Grok audit 2026-10-02, finding 2: micNotice (a mic error such as permission denied) never
 * reached the dock — AssistantField read it off use-composer-input but never rendered it — and
 * the textarea stayed editable while dictation was live, letting a stray keystroke interleave
 * with the transcript. Both are proven here against the full dock, the way coach-search.test.tsx
 * proves the rest of AssistantField's behaviour.
 */

const speech = vi.hoisted(() => ({ handlers: [] as SpeechHandlers[] }));
vi.mock("@/lib/coach/speech-api", () => ({
  micAvailable: () => true,
  startListening: (handlers: SpeechHandlers) => {
    speech.handlers.push(handlers);
    return { stop: vi.fn(), abort: vi.fn() };
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/CapabilitiesProvider", () => ({
  useCapabilities: () => ({ coach: true, scan: true, captureMethods: ["photo"] }),
}));

afterEach(() => {
  cleanup();
  speech.handlers.length = 0;
});

const field = () => screen.getByRole("searchbox", { name: "Ask Sasha" }) as HTMLTextAreaElement;

describe("the dock's mic notice and dictation lock", () => {
  it("shows a denied-permission notice as a status line", () => {
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Record message" }));
    act(() => speech.handlers[0].onError("not-allowed"));

    expect(screen.getByRole("status").textContent).toBe(PERMISSION_COPY);
  });

  it("locks the textarea read-only while dictation is live", () => {
    render(<TabBar />);
    expect(field().readOnly).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Record message" }));
    expect(field().readOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    act(() => speech.handlers[0].onEnd());
    expect(field().readOnly).toBe(false);
  });
});
