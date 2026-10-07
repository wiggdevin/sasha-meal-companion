// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachMessageExtras } from "@/components/CoachChat";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { captureProposal } from "@/tests/coach/editors/fixtures";

const seen = vi.hoisted(() => [] as Array<{
  block: LogDraftBlockV1;
  used: boolean | undefined;
  rerun: () => void;
}>);

vi.mock("@/components/coach/blocks", () => ({
  renderBlock: (block: LogDraftBlockV1, ctx: {
    rerunAsLabel: () => void;
    rerunAsLabelUsed?: boolean;
  }) => {
    seen.push({ block, used: ctx.rerunAsLabelUsed, rerun: ctx.rerunAsLabel });
    return <button type="button" disabled={ctx.rerunAsLabelUsed}
      onClick={ctx.rerunAsLabel}>This was a nutrition label</button>;
  },
}));

afterEach(() => { cleanup(); seen.length = 0; });

describe("label rerun state", () => {
  it("keeps the original photo block unchanged and marks its rerun control used", async () => {
    const mediaPath = "media/user/photo.jpg";
    const block: LogDraftBlockV1 = {
      kind: "log_draft", v: 1, id: "photo-block", source: "capture", method: "photo",
      localDate: "2026-09-19", draft: captureProposal,
      policy: { blocked: false }, status: "pending",
    };
    const user: CoachMessageView = { id: "u1", role: "user", content: "Sent a photo", seq: 1,
      createdAt: "2026-09-19T16:00:00.000Z",
      attachments: [{ kind: "capture", v: 1, method: "photo", mediaPath,
        localDate: "2026-09-19" }] };
    const assistant: CoachMessageView = { id: "a1", role: "assistant", content: "Check it", seq: 2,
      createdAt: "2026-09-19T16:00:01.000Z", blocks: [block] };
    const onAttachment = vi.fn().mockResolvedValue(true);
    render(<CoachMessageExtras message={assistant} messages={[user, assistant]}
      tz="America/Denver" onAttachment={onAttachment} onSearchManually={vi.fn()}
      onBlockStatus={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "This was a nutrition label" }));

    await waitFor(() => expect(seen.at(-1)?.used).toBe(true));
    expect(seen.at(-1)?.block).toBe(block);
    expect(seen.at(-1)?.block.method).toBe("photo");
    expect((screen.getByRole("button", {
      name: "This was a nutrition label",
    }) as HTMLButtonElement).disabled).toBe(true);
  });
});
