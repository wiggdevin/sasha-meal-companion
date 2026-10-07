// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickRepliesBlock from "@/components/coach/blocks/quick_replies";
import type { QuickRepliesBlockV1 } from "@/lib/coach/ui-blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";

afterEach(cleanup);

describe("quick replies block", () => {
  it("sends one exact new turn and hides every chip once one is used", () => {
    const sendText = vi.fn();
    render(<QuickRepliesBlock block={{ kind: "quick_replies", v: 1, id: "quick-1",
      options: ["Show today", "Plan tomorrow"] }} ctx={blockContext({ sendText })} />);

    fireEvent.click(screen.getByRole("button", { name: "Show today" }));

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith("Show today");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps every offered chip at least 44 px and omits a chip that is not the latest reply", () => {
    const block: QuickRepliesBlockV1 = { kind: "quick_replies", v: 1, id: "quick-1",
      options: ["Show today", "Plan tomorrow"] };
    const current = render(<QuickRepliesBlock block={block} ctx={blockContext()} />);
    for (const button of screen.getAllByRole("button")) {
      expect(Number.parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(44);
    }
    current.unmount();
    const stale = render(<QuickRepliesBlock block={block}
      ctx={blockContext({ isLatestAssistant: false })} />);
    expect(stale.container.innerHTML).toBe("");
  });
});
