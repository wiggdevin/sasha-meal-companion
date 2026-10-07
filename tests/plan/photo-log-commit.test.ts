/**
 * A Plan panel log commits as the account the capture started as (lib/plan/photo-log.ts): the
 * handle reaches commitDraft, and an account switch before or during the commit throws
 * AccountChanged instead of reporting a result. The capture pipeline is mocked; no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";

vi.mock("@/lib/capture-client", async (original) => ({
  ...(await original<typeof import("@/lib/capture-client")>()),
  captureText: vi.fn(),
  captureMedia: vi.fn(),
  commitDraft: vi.fn(),
}));

const { captureMedia, captureText, commitDraft } = await import("@/lib/capture-client");
const { commitPanelDraft, logDescribed, proposeDescribed, proposePlate, scaleDraft } = await import("@/lib/plan/photo-log");

const draftOutcome = {
  kind: "draft", run: undefined,
  draft: { draftId: "d1", method: "text", items: [{ seq: 0, grams: 150, foodRefId: "ref-1", label: "chicken",
    policy: { verdict: "allowed" } }] },
} as never;

afterEach(() => { unbindAccount(); vi.mocked(commitDraft).mockReset(); });

describe("Plan panel log commit", () => {
  it("passes the capture's account handle through commitDraft", async () => {
    const h = bindAccount("user-a");
    vi.mocked(captureText).mockResolvedValue(draftOutcome);
    vi.mocked(commitDraft).mockResolvedValue({ status: "ok" } as never);
    const out = await logDescribed(h, "grilled chicken", "meal-2");
    expect(out.ok).toBe(true);
    expect(vi.mocked(commitDraft).mock.calls[0][2]).toMatchObject({ slot: "meal-2", account: h });
  });

  it("throws AccountChanged and commits nothing when the account switched after propose", async () => {
    const h = bindAccount("user-a");
    vi.mocked(captureText).mockImplementation(async () => { bindAccount("user-b"); return draftOutcome; });
    await expect(logDescribed(h, "grilled chicken", "meal-2")).rejects.toBeInstanceOf(AccountChanged);
    expect(commitDraft).not.toHaveBeenCalled();
  });

  it("rethrows AccountChanged when the account switched during the commit", async () => {
    const h = bindAccount("user-a");
    vi.mocked(captureText).mockResolvedValue(draftOutcome);
    vi.mocked(commitDraft).mockImplementation(async () => { bindAccount("user-b"); return { status: "owned_elsewhere" } as never; });
    await expect(logDescribed(h, "grilled chicken", "meal-2")).rejects.toBeInstanceOf(AccountChanged);
  });
});

describe("Plan panel review (AI audit B3: nothing logs before the person sees it)", () => {
  it("proposes a plate or a dish without committing anything", async () => {
    const h = bindAccount("user-a");
    vi.mocked(captureText).mockResolvedValue(draftOutcome);
    vi.mocked(captureMedia).mockResolvedValue(draftOutcome);
    const described = await proposeDescribed(h, "grilled chicken", "meal-2");
    const plate = await proposePlate(h, new Blob(["x"]), "meal-2", 1.5);
    expect(described.ok && described.pending.slot).toBe("meal-2");
    // The plate's portion is applied to the draft that will be shown, so what is seen is what logs.
    expect(plate.ok && plate.pending.draft.items[0].grams).toBe(225);
    expect(commitDraft).not.toHaveBeenCalled();
  });

  it("commits the shown draft with the person's edits, as the capture's account", async () => {
    const h = bindAccount("user-a");
    vi.mocked(captureText).mockResolvedValue(draftOutcome);
    vi.mocked(commitDraft).mockResolvedValue({ status: "ok" } as never);
    const proposal = await proposeDescribed(h, "grilled chicken", "meal-2");
    if (!proposal.ok) throw new Error("expected a draft");
    const out = await commitPanelDraft(h, proposal.pending, { 0: { grams: 90 } });
    expect(out.ok).toBe(true);
    expect(vi.mocked(commitDraft).mock.calls[0][1]).toEqual({ 0: { grams: 90 } });
    expect(vi.mocked(commitDraft).mock.calls[0][2]).toMatchObject({ slot: "meal-2", account: h });
  });

  it("refuses a draft whose kept items the rules block, without committing", async () => {
    const h = bindAccount("user-a");
    const blocked = { kind: "draft", run: undefined, draft: { draftId: "d2", method: "text", items: [
      { seq: 0, grams: 30, foodRefId: "ref-2", label: "peanuts", policy: { verdict: "blocked" } }] } } as never;
    vi.mocked(captureText).mockResolvedValue(blocked);
    const proposal = await proposeDescribed(h, "peanuts", "meal-2");
    if (!proposal.ok) throw new Error("expected a draft");
    const out = await commitPanelDraft(h, proposal.pending, {});
    expect(out).toMatchObject({ ok: false });
    expect(commitDraft).not.toHaveBeenCalled();
  });

  it("scales a plate's grams by the chosen portion and leaves 1× alone", () => {
    const draft = (draftOutcome as unknown as { draft: Parameters<typeof scaleDraft>[0] }).draft;
    expect(scaleDraft(draft, 1)).toBe(draft);
    expect(scaleDraft(draft, 0.5).items[0]).toMatchObject({ grams: 75 });
  });
});
