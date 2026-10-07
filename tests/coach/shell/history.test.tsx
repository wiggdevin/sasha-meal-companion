// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  capturePrependAnchor, HISTORY_PAGE_SIZE, prependMessages, restorePrependAnchor,
} from "@/lib/coach/thread-history";
import { fetchOlder, getThread, type CachedMessage } from "@/lib/coach-client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const rows = (start: number, end: number): CachedMessage[] => Array.from(
  { length: end - start + 1 }, (_, index) => ({
    id: `message-${start + index}`, role: "assistant", content: `Message ${start + index}`,
    seq: start + index,
  }),
);

function HistoryHarness() {
  const [messages, setMessages] = useState(rows(3, 4));
  const scroller = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof capturePrependAnchor>>(null);
  useLayoutEffect(() => {
    if (scroller.current && pending.current) restorePrependAnchor(scroller.current, pending.current);
    pending.current = null;
  }, [messages]);
  return <div>
    <button type="button" onClick={() => {
      pending.current = capturePrependAnchor(scroller.current!);
      setMessages((current) => prependMessages(current, rows(1, 2)));
    }}>Older</button>
    <div ref={scroller} data-testid="history-scroller">
      {messages.map((message) => <p key={message.id}>{message.content}</p>)}
    </div>
  </div>;
}

describe("coach thread history", () => {
  afterEach(cleanup);

  it("preserves the visible anchor when older messages prepend", async () => {
    const { getByRole, getByTestId } = render(<HistoryHarness />);
    const scroller = getByTestId("history-scroller");
    let top = 80;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true,
        get: () => scroller.querySelectorAll("p").length === 2 ? 400 : 700 },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
    });

    fireEvent.click(getByRole("button", { name: "Older" }));

    expect(top).toBe(380);
  });

  it("sends the oldest sequence and requested page size to the existing endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await fetchOlder("thread-1", 12, 20, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/coach/threads/thread-1?before=12&limit=20",
      expect.any(Object),
    );
  });

  it("requests the restore page with the shared history page size", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      thread: { id: "thread-1", title: null, kind: "chat", lastMessageAt: null },
      messages: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await getThread("thread-1", { limit: HISTORY_PAGE_SIZE }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/coach/threads/thread-1?limit=50",
      expect.any(Object),
    );
  });
});
