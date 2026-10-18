// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Transcript, { type TranscriptHandle } from "@/components/coach/Transcript";
import type { ChatMessage } from "@/lib/coach/chat-state";

function message(seq: number): ChatMessage {
  return { id: `message-${seq}`, role: seq % 2 ? "user" : "assistant", content: `Message ${seq}`, seq };
}

function setGeometry(element: HTMLElement, values: {
  scrollHeight: number; clientHeight: number; scrollTop: number;
}) {
  let top = values.scrollTop;
  let height = values.scrollHeight;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => values.clientHeight },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
  });
  return {
    top: () => top,
    setHeight: (value: number) => { height = value; },
    setTop: (value: number) => { top = value; },
  };
}

describe("coach transcript bottom follow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["restore", "send", "reply"])("follows the bottom after %s near the bottom", (reason) => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 600, clientHeight: 300, scrollTop: 270 });

    act(() => ref.current?.captureBeforeUpdate());
    view.rerender(
      <Transcript ref={ref} messages={[message(1), message(2)]} contentVersion={`${reason}-1`} />,
    );

    expect(geometry.top()).toBe(600);
  });

  it("leaves a reader re-reading less than a screen up where they are while a reply streams", () => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 600, clientHeight: 300, scrollTop: 150 });
    fireEvent.scroll(scroller);

    act(() => ref.current?.captureBeforeUpdate());
    view.rerender(<Transcript ref={ref} messages={[message(1), message(2)]} contentVersion={1} />);

    expect(geometry.top()).toBe(150);
    expect(view.getByRole("button", { name: "New message" })).not.toBeNull();
  });

  it("always follows the reader's own send", () => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(scroller);

    act(() => ref.current?.captureBeforeUpdate(true));
    view.rerender(<Transcript ref={ref} messages={[message(1), message(2)]} contentVersion={1} />);

    expect(geometry.top()).toBe(600);
  });

  it("announces a reply that lands, never the restored history", () => {
    const view = render(<Transcript messages={[message(1), message(2)]} contentVersion={0} />);
    const live = view.getByRole("status");
    expect(live.textContent).toBe("");
    view.rerender(<Transcript messages={[message(1), message(2), message(3)]} contentVersion={1} />);
    expect(live.textContent).toBe("");
    view.rerender(<Transcript messages={[message(1), message(2), message(3), message(4)]} contentVersion={2} />);
    expect(live.textContent).toContain("Message 4");
    expect(view.getByLabelText("Conversation").getAttribute("aria-live")).toBeNull();
  });

  it("does not yank a reader more than one viewport away and offers a new-message pill", () => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(scroller);

    act(() => ref.current?.captureBeforeUpdate());
    view.rerender(<Transcript ref={ref} messages={[message(1), message(2)]} contentVersion={1} />);

    expect(geometry.top()).toBe(100);
    expect(view.getByRole("button", { name: "New message" })).not.toBeNull();
  });

  it("moves to the bottom and hides the pill when the pill is tapped", () => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(scroller);
    act(() => ref.current?.captureBeforeUpdate());
    view.rerender(<Transcript ref={ref} messages={[message(1), message(2)]} contentVersion={1} />);

    fireEvent.click(view.getByRole("button", { name: "New message" }));

    expect(geometry.top()).toBe(1_000);
    expect(view.queryByRole("button", { name: "New message" })).toBeNull();
  });

  it("keeps the bottom pinned when a rendered card grows", () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const view = render(<Transcript messages={[message(1)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 800 });
    fireEvent.scroll(scroller);

    geometry.setHeight(1_200);
    act(() => resize([], {} as ResizeObserver));

    expect(geometry.top()).toBe(1_200);
  });

  it("corrects a prepend anchor on resize until the reader scrolls", () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(3), message(4)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 400, clientHeight: 200, scrollTop: 80 });

    act(() => ref.current?.capturePrependAnchor());
    geometry.setHeight(700);
    view.rerender(<Transcript ref={ref}
      messages={[message(1), message(2), message(3), message(4)]} contentVersion={0} />);
    act(() => ref.current?.restorePrependAnchor());
    expect(geometry.top()).toBe(380);

    geometry.setHeight(800);
    act(() => resize([], {} as ResizeObserver));
    expect(geometry.top()).toBe(480);

    geometry.setTop(450);
    fireEvent.scroll(scroller);
    geometry.setHeight(900);
    act(() => resize([], {} as ResizeObserver));
    expect(geometry.top()).toBe(450);
  });

  it("keeps the visible row during an in-flight prepend, then resumes pinned follow", () => {
    const ref = createRef<TranscriptHandle>();
    const view = render(<Transcript ref={ref} messages={[message(3), message(4)]} contentVersion={0} />);
    const scroller = view.getByLabelText("Conversation");
    const geometry = setGeometry(scroller, { scrollHeight: 400, clientHeight: 200, scrollTop: 80 });
    fireEvent.scroll(scroller);

    act(() => ref.current?.capturePrependAnchor());
    geometry.setHeight(500);
    view.rerender(<Transcript ref={ref}
      messages={[message(3), message(4), message(5)]} contentVersion={1} />);
    expect(geometry.top()).toBe(80);

    act(() => ref.current?.capturePrependAnchor());
    geometry.setHeight(800);
    view.rerender(<Transcript ref={ref}
      messages={[message(1), message(2), message(3), message(4), message(5)]} contentVersion={1} />);
    act(() => ref.current?.restorePrependAnchor());
    expect(geometry.top()).toBe(380);

    geometry.setTop(600);
    fireEvent.scroll(scroller);
    act(() => ref.current?.captureBeforeUpdate());
    geometry.setHeight(900);
    view.rerender(<Transcript ref={ref}
      messages={[message(1), message(2), message(3), message(4), message(5), message(6)]}
      contentVersion={2} />);
    expect(geometry.top()).toBe(900);
  });

  it("requests older history within 200 pixels of the top", () => {
    const onLoadOlder = vi.fn();
    const view = render(<Transcript messages={[message(1)]} contentVersion={0}
      hasOlder onLoadOlder={onLoadOlder} />);
    const scroller = view.getByLabelText("Conversation");
    setGeometry(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 199 });

    fireEvent.scroll(scroller);

    expect(onLoadOlder).toHaveBeenCalledOnce();
  });
});
