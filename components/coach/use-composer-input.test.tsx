// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canShowRecord, useComposerInput } from "@/components/coach/use-composer-input";

afterEach(cleanup);

/** The minimum either consumer (the dock's AssistantField, and the page composer before it) needs
 *  to exercise the hook's own Enter-to-send rule — no CoachMic, no caret-sensitive Record/Send. */
function Field({ onSend }: { onSend: (text: string) => void }) {
  const { input, textEvents } = useComposerInput(false, onSend);
  return <textarea aria-label="Message" ref={input} {...textEvents} />;
}

/**
 * The page composer that proved this hook's integration with CoachMic (a caret-sensitive
 * Record/Send toggle: typed text kept Record available to append dictation while the caret sat
 * at the draft's end) is gone — the dock's AssistantField is the one ask field now. The dock
 * briefly used a simpler rule instead (any non-empty, non-listening draft is Send-ready; PR #296),
 * but the Grok audit (2026-10-02, finding 1) found that it made a dictated transcript impossible
 * to extend, so the caret nuance is carried over to the dock after all — proven end to end in
 * tests/tabbar/coach-search.test.tsx. `canShowRecord` itself stays covered here as the hook's own
 * pure rule.
 */
describe("canShowRecord", () => {
  it("shows Record for an empty draft whatever the caret", () => {
    expect(canShowRecord("", 0, 0)).toBe(true);
    expect(canShowRecord("", null, null)).toBe(true);
  });

  it("shows Record only for a collapsed caret at the end of a draft", () => {
    expect(canShowRecord("hello", 5, 5)).toBe(true);
    expect(canShowRecord("hello", 2, 2)).toBe(false);
    expect(canShowRecord("hello", 0, 5)).toBe(false);
    expect(canShowRecord("hello", 5, 4)).toBe(false);
  });

  it("keeps Record when the element reports no caret", () => {
    expect(canShowRecord("hello", null, null)).toBe(true);
  });
});

describe("Enter-to-send", () => {
  it("sends once on Enter and never on Shift+Enter or IME composition", () => {
    const onSend = vi.fn();
    render(<Field onSend={onSend} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "breakfast" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledExactlyOnceWith("breakfast");
    expect(input.value).toBe("");
  });
});
