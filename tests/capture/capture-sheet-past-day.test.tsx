// @vitest-environment jsdom
/**
 * UI audit 2026-10-07 (Sol on the Log BLOCK): a capture handed off from a past day's meal card was
 * committed at now, under today. It now carries the day on screen and the card's slot.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { captureProposal } from "@/tests/coach/editors/fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const capture = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock("@/lib/capture-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capture-client")>(),
  commitDraft: capture.commit,
}));

const { default: CaptureSheet } = await import("@/components/CaptureSheet");

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); capture.commit.mockReset().mockResolvedValue({ status: "queued" }); });
afterEach(() => { cleanup(); unbindAccount(); });

describe("a capture from a past day's meal card", () => {
  it("commits at that day's time, in the card's slot", async () => {
    const at = new Date("2026-10-05T08:30:00");
    const noop = () => {};
    render(<CaptureSheet open initialMode="confirm" initialDraft={captureProposal} at={at} slot="meal-2"
      onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    const log = screen.getAllByRole("button").find((button) => /^(Log it|Save \d)/.test(button.textContent ?? ""));
    expect(log).toBeTruthy();
    await act(async () => { fireEvent.click(log!); });
    expect(capture.commit).toHaveBeenCalledOnce();
    const ctx = capture.commit.mock.calls[0][2] as { eatenAt?: Date; slot: string };
    expect(ctx.eatenAt?.getTime()).toBe(at.getTime());
    expect(ctx.slot).toBe("meal-2");
  });

  it("commits at the time the user set on the sheet, on that same day (W125)", async () => {
    const at = new Date("2026-10-05T08:30:00");
    const noop = () => {};
    render(<CaptureSheet open initialMode="confirm" initialDraft={captureProposal} at={at} slot="meal-2"
      onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    const time = screen.getByLabelText("Eaten at") as HTMLInputElement;
    expect(time.value).toBe("08:30");
    fireEvent.change(time, { target: { value: "07:45" } });
    fireEvent.change(screen.getByLabelText("Meal name"), { target: { value: "Early oats" } });
    const log = screen.getAllByRole("button").find((button) => /^(Log it|Save \d)/.test(button.textContent ?? ""));
    await act(async () => { fireEvent.click(log!); });
    const ctx = capture.commit.mock.calls[0][2] as { eatenAt?: Date; title?: string };
    expect(ctx.eatenAt?.getTime()).toBe(new Date("2026-10-05T07:45:00").getTime());
    expect(ctx.title).toBe("Early oats");
  });
});
