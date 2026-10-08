// @vitest-environment jsdom
/**
 * Phase 18 W5b-2 UI: the shared "one taste text" field. Mocks the lib client boundary
 * (requestTasteChips / confirmTasteChips / undoTasteChips / newTasteActionId / readTasteChipsEnabled)
 * so these tests pin UI behaviour only — the server contract itself is covered by the backend's own
 * tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TasteChipsField, { TASTE_PICK_MAX } from "@/components/profile/TasteChipsField";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { TasteSuggestion } from "@/lib/profile/taste-chips";
import type { TasteConfirmRequest, TasteConfirmResult, TasteUndoResult } from "@/lib/profile/taste-confirm";

type TasteChipsAnswer =
  | { ok: true; suggestion: TasteSuggestion }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "failed"; status?: number };

const lib = vi.hoisted(() => ({
  request: vi.fn<(text: string) => Promise<TasteChipsAnswer>>(),
  enabled: vi.fn<() => Promise<"enabled" | "disabled" | "unknown">>(async () => "enabled"),
  confirm: vi.fn(),
  undo: vi.fn(),
  nextActionId: vi.fn(() => "action-1"),
}));

vi.mock("@/lib/profile/prefs-client", () => ({ requestTasteChips: lib.request }));
vi.mock("@/lib/profile/taste-enabled-client", () => ({ readTasteChipsEnabled: lib.enabled }));
vi.mock("@/lib/profile/taste-confirm-client", () => ({
  confirmTasteChips: lib.confirm,
  undoTasteChips: lib.undo,
  newTasteActionId: lib.nextActionId,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); lib.enabled.mockResolvedValue("enabled"); });

const SEND: Extract<TasteSuggestion, { route: "send" }> = {
  route: "send",
  jev: true,
  likes: [{ key: "f:Salmon", label: "Salmon", p: 0.95 }],
  dislikes: [
    { key: "f:Okra", label: "Okra", p: 0.9 },
    { key: "t:slimy", label: "Slimy textures", p: 0.85 },
  ],
  cuisines: [{ key: "latin_american", label: "Mexican and Latin American", p: 0.88 }],
};

function okConfirm(overrides: Partial<TasteConfirmResult> = {}) {
  return {
    ok: true as const,
    result: {
      status: "applied", actionId: "action-1",
      added: { dislikes: ["f:Okra"], cuisines: [] },
      present: { dislikes: [], cuisines: [] },
      capped: { dislikes: [], cuisines: [] },
      undoneAt: null,
      settings: {},
      ...overrides,
    } satisfies TasteConfirmResult,
  };
}

function okUndo(overrides: Partial<TasteUndoResult> = {}) {
  return {
    ok: true as const,
    result: {
      status: "undone", actionId: "action-1",
      removed: { dislikes: ["f:Okra"], cuisines: [] },
      gone: { dislikes: [], cuisines: [] },
      undoneAt: "2026-10-06T00:00:00.000Z",
      settings: {},
      ...overrides,
    } satisfies TasteUndoResult,
  };
}

/** Renders the field and waits past the mount-time `readTasteChipsEnabled` gate. */
async function renderEnabled(source: "settings" | "onboarding" = "settings") {
  const result = render(<TasteChipsField source={source} />);
  await screen.findByLabelText("A taste, in your own words");
  return result;
}

async function type(value: string) {
  const field = screen.getByLabelText("A taste, in your own words");
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  await waitFor(() => expect(lib.request).toHaveBeenCalled());
}

describe("TasteChipsField", () => {
  it("renders nothing until the enabled probe answers, then shows the field", async () => {
    let resolveEnabled: (value: "enabled") => void = () => {};
    lib.enabled.mockReturnValueOnce(new Promise((resolve) => { resolveEnabled = resolve; }));
    const { container } = render(<TasteChipsField source="settings" />);
    expect(container.innerHTML).toBe("");
    resolveEnabled("enabled");
    await screen.findByLabelText("A taste, in your own words");
  });

  it("hides the heading and divider along with the field when disabled (no bare heading left behind)", async () => {
    lib.enabled.mockResolvedValue("disabled");
    const { container } = render(<TasteChipsField source="onboarding" heading="Any taste you want to add?" />);
    await waitFor(() => expect(lib.enabled).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Any taste you want to add?")).toBeNull();
  });

  it("shows the heading only once the field itself renders", async () => {
    let resolveEnabled: (value: "enabled") => void = () => {};
    lib.enabled.mockReturnValueOnce(new Promise((resolve) => { resolveEnabled = resolve; }));
    render(<TasteChipsField source="onboarding" heading="Any taste you want to add?" />);
    expect(screen.queryByText("Any taste you want to add?")).toBeNull(); // not yet resolved
    resolveEnabled("enabled");
    await screen.findByText("Any taste you want to add?");
    expect(screen.getByLabelText("A taste, in your own words")).toBeTruthy();
  });

  it("stays hidden when the probe answers disabled", async () => {
    lib.enabled.mockResolvedValue("disabled");
    const { container } = render(<TasteChipsField source="settings" />);
    await waitFor(() => expect(lib.enabled).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden when the probe answers unknown (offline, timeout, bad shape)", async () => {
    lib.enabled.mockResolvedValue("unknown");
    const { container } = render(<TasteChipsField source="settings" />);
    await waitFor(() => expect(lib.enabled).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden, with no unhandled rejection, when the probe itself rejects", async () => {
    lib.enabled.mockRejectedValue(new Error("account changed"));
    const { container } = render(<TasteChipsField source="settings" />);
    await waitFor(() => expect(lib.enabled).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
  });

  it("writes nothing on mount and sends no request before the user blurs the field", async () => {
    await renderEnabled();
    expect(screen.getByLabelText("A taste, in your own words")).toBeTruthy();
    expect(lib.request).not.toHaveBeenCalled();
    expect(lib.confirm).not.toHaveBeenCalled();
  });

  it("shows the rule hand-off for a kept-local answer, and sends nothing", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: { route: "local", reason: "rules", offer: "rule_editor" } });
    await renderEnabled("onboarding");
    await type("I'm allergic to peanuts");
    expect(await screen.findByRole("status")).toHaveProperty("textContent",
      expect.stringContaining("food rule"));
    expect(lib.confirm).not.toHaveBeenCalled();
  });

  it("shows dislikes and cuisines as toggles for a sent answer, and never shows likes", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    await renderEnabled();
    await type("I can't stand okra, it's slimy, and I grew up on Tex-Mex");
    expect(await screen.findByRole("button", { name: "Okra" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Slimy textures" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mexican and Latin American" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salmon" })).toBeNull();
  });

  it(`caps the picked chips at ${TASTE_PICK_MAX}`, async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: {
      ...SEND,
      dislikes: [
        { key: "f:Okra", label: "Okra", p: 0.9 },
        { key: "t:slimy", label: "Slimy textures", p: 0.9 },
        { key: "t:bitter", label: "Bitter flavors", p: 0.9 },
      ],
      cuisines: [{ key: "latin_american", label: "Mexican and Latin American", p: 0.9 }],
    } });
    await renderEnabled();
    await type("okra slimy bitter tex-mex");
    for (const name of ["Okra", "Slimy textures", "Bitter flavors"]) {
      fireEvent.click(await screen.findByRole("button", { name }));
    }
    expect(screen.getByText(`${TASTE_PICK_MAX} of ${TASTE_PICK_MAX} picked`)).toBeTruthy();
    const latinAmerican = screen.getByRole("button", { name: "Mexican and Latin American" });
    expect(latinAmerican.hasAttribute("disabled")).toBe(true);
    fireEvent.click(latinAmerican);
    expect(screen.getByText(`${TASTE_PICK_MAX} of ${TASTE_PICK_MAX} picked`)).toBeTruthy();
  });

  it("writes nothing until Confirm, then writes exactly the picked chips with one action id", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue(okConfirm());
    await renderEnabled("onboarding");
    await type("okra and tex-mex");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Mexican and Latin American" }));
    expect(lib.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(1));
    const request = lib.confirm.mock.calls[0][0] as TasteConfirmRequest;
    expect(request).toEqual({
      actionId: "action-1", source: "onboarding", dislikes: ["f:Okra"], cuisines: ["latin_american"],
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("offers Undo on success, calling undoTasteChips with the same action id", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue(okConfirm());
    lib.undo.mockResolvedValue(okUndo());
    await renderEnabled();
    await type("okra");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lib.undo).toHaveBeenCalledWith("action-1"));
    expect(await screen.findByText("Removed.")).toBeTruthy();
  });

  it("says offline honestly and keeps the chips picked, sending nothing", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue({ ok: false, reason: "offline" });
    await renderEnabled();
    await type("okra");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("This waits for a connection.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Okra" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a retry message and reuses the same action id on a retry tap", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValueOnce({ ok: false, reason: "retry", message: "No connection. Try again." });
    lib.confirm.mockResolvedValueOnce(okConfirm());
    await renderEnabled();
    await type("okra");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("No connection. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(2));
    expect(lib.confirm.mock.calls[0][0].actionId).toBe(lib.confirm.mock.calls[1][0].actionId);
  });

  it("shows the server's refusal message honestly", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue({ ok: false, reason: "refused", status: 422, code: "chip_not_proposed",
      message: "That chip wasn't offered." });
    await renderEnabled();
    await type("okra");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("That chip wasn't offered.")).toBeTruthy();
  });

  it("mints a fresh action id once the picked selection changes after a failure", async () => {
    lib.nextActionId.mockReturnValueOnce("action-1").mockReturnValueOnce("action-2");
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue({ ok: false, reason: "refused", status: 422, code: "chip_not_proposed",
      message: "That chip wasn't offered." });
    await renderEnabled();
    await type("okra and tex-mex");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Okra" })); // deselect
    fireEvent.click(screen.getByRole("button", { name: "Mexican and Latin American" })); // a different selection
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(2));
    expect(lib.confirm.mock.calls[0][0].actionId).not.toBe(lib.confirm.mock.calls[1][0].actionId);
  });

  it("shows a transient-failure message and keeps the field, manual chips untouched", async () => {
    lib.request.mockResolvedValue({ ok: false, reason: "failed" });
    await renderEnabled();
    await type("whatever flips the route to send");
    expect(await screen.findByText("No suggestions right now. Try again.")).toBeTruthy();
    // The field itself (and anything else on the page) stays mounted and usable.
    expect(screen.getByLabelText("A taste, in your own words")).toBeTruthy();
  });

  it("hides the whole block once requestTasteChips itself reports the flag disabled", async () => {
    lib.request.mockResolvedValue({ ok: false, reason: "disabled" });
    const { container } = await renderEnabled();
    await type("whatever flips the route to send");
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("clears a prior transient-failure message once a later check succeeds", async () => {
    lib.request.mockResolvedValueOnce({ ok: false, reason: "failed" });
    await renderEnabled();
    await type("okra");
    await screen.findByText("No suggestions right now. Try again.");
    lib.request.mockResolvedValueOnce({ ok: true, suggestion: SEND });
    await type("okra and tex-mex");
    await screen.findByRole("button", { name: "Okra" });
    expect(screen.queryByText("No suggestions right now. Try again.")).toBeNull();
  });

  it("never lets a stale in-flight check answer for text that was cleared", async () => {
    let resolveFirst: (value: TasteChipsAnswer) => void = () => {};
    lib.request.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    await renderEnabled();
    const field = screen.getByLabelText("A taste, in your own words");
    fireEvent.change(field, { target: { value: "okra" } });
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field); // cleared before the first check answers
    resolveFirst({ ok: true, suggestion: SEND });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Okra" })).toBeNull();
    expect(screen.getByLabelText("A taste, in your own words")).toBeTruthy(); // not folded
  });

  it("reflects present and capped chips honestly instead of claiming every pick was added", async () => {
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockResolvedValue(okConfirm({
      added: { dislikes: [], cuisines: [] },
      present: { dislikes: ["f:Okra"], cuisines: [] },
      capped: { dislikes: [], cuisines: ["latin_american"] },
    }));
    await renderEnabled();
    await type("okra and tex-mex");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Mexican and Latin American" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/1 wasn't added — the limit is reached\./)).toBeTruthy();
    // Nothing was added by this action, so there is nothing for Undo to remove.
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("pauses chip toggling while a confirm is in flight, so a late success never discards a newer pick", async () => {
    let resolveConfirm: (value: unknown) => void = () => {};
    lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
    lib.confirm.mockImplementationOnce(() => new Promise((resolve) => { resolveConfirm = resolve; }));
    await renderEnabled();
    await type("okra and tex-mex");
    fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(1));
    const mexican = screen.getByRole("button", { name: "Mexican and Latin American" });
    expect(mexican.hasAttribute("disabled")).toBe(true); // paused mid-write
    fireEvent.click(mexican); // ignored while pending
    resolveConfirm(okConfirm());
    await waitFor(() => expect(screen.getByRole("button", { name: "Mexican and Latin American" })
      .hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Mexican and Latin American" }).getAttribute("aria-pressed"))
      .toBe("false"); // the ignored click never stuck
  });

  describe("settings_not_synced is a manual Try again, never an automatic retry (Sol round 3 BLOCK)", () => {
    afterEach(() => unbindAccount());

    it("never sends a second request on its own after a 409 settings_not_synced", async () => {
      bindAccount("user-onboarding");
      lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
      lib.confirm.mockResolvedValue({ ok: false, reason: "refused", status: 409,
        code: "settings_not_synced", message: "Your settings have not reached the server yet. Try again after it syncs." });
      await renderEnabled("onboarding");
      await type("okra");
      fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText("Your settings have not reached the server yet. Try again after it syncs.")).toBeTruthy();
      expect(lib.confirm).toHaveBeenCalledTimes(1); // no automatic second call, onboarding or not
    });

    it("never sends a second request outside onboarding either (Settings source)", async () => {
      bindAccount("user-settings");
      lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
      lib.confirm.mockResolvedValue({ ok: false, reason: "refused", status: 409,
        code: "settings_not_synced", message: "Your settings have not reached the server yet. Try again after it syncs." });
      await renderEnabled("settings");
      await type("okra");
      fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText("Your settings have not reached the server yet. Try again after it syncs.")).toBeTruthy();
      expect(lib.confirm).toHaveBeenCalledTimes(1);
    });

    it("offers a Try again control on settings_not_synced, which re-sends with the SAME action id", async () => {
      bindAccount("user-onboarding");
      lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
      lib.confirm.mockResolvedValueOnce({ ok: false, reason: "refused", status: 409,
        code: "settings_not_synced", message: "Your settings have not reached the server yet. Try again after it syncs." });
      lib.confirm.mockResolvedValueOnce(okConfirm());
      await renderEnabled("onboarding");
      await type("okra");
      fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(1));
      const tryAgain = await screen.findByRole("button", { name: "Try again" });
      fireEvent.click(tryAgain);
      await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(2));
      expect(lib.confirm.mock.calls[0][0].actionId).toBe(lib.confirm.mock.calls[1][0].actionId);
      expect(await screen.findByText("Saved.")).toBeTruthy();
    });

    it("Try again can be tapped more than once, the server refusing harmlessly each time the row still has not landed", async () => {
      bindAccount("user-onboarding");
      lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
      lib.confirm.mockResolvedValue({ ok: false, reason: "refused", status: 409,
        code: "settings_not_synced", message: "Your settings have not reached the server yet. Try again after it syncs." });
      await renderEnabled("onboarding");
      await type("okra");
      fireEvent.click(await screen.findByRole("button", { name: "Okra" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(2));
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(lib.confirm).toHaveBeenCalledTimes(3));
      const ids = lib.confirm.mock.calls.map((call: unknown[]) => (call[0] as { actionId: string }).actionId);
      expect(new Set(ids).size).toBe(1); // every attempt is the same tap's action id
    });
  });

  describe("manual preset chips when Jev is down (followup #3)", () => {
    it("offers a static preset picker instead of 'nothing to suggest' when jev:false", async () => {
      lib.request.mockResolvedValue({ ok: true, suggestion: {
        route: "send", jev: false, likes: [], dislikes: [], cuisines: [],
      } });
      await renderEnabled();
      await type("something Jev couldn't classify");
      expect(await screen.findByText(/pick any that fit instead/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Spicy heat" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "American" })).toBeTruthy();
      expect(screen.queryByText("Nothing to suggest from that yet.")).toBeNull();
    });

    it("confirms a preset pick like any other chip", async () => {
      lib.request.mockResolvedValue({ ok: true, suggestion: {
        route: "send", jev: false, likes: [], dislikes: [], cuisines: [],
      } });
      lib.confirm.mockResolvedValue(okConfirm({ added: { dislikes: ["t:spicy_hot"], cuisines: [] } }));
      await renderEnabled();
      await type("something Jev couldn't classify");
      fireEvent.click(await screen.findByRole("button", { name: "Spicy heat" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(lib.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ dislikes: ["t:spicy_hot"], cuisines: [] }),
      ));
    });

    it("still shows real suggestions, not presets, when jev:true answers with chips", async () => {
      lib.request.mockResolvedValue({ ok: true, suggestion: SEND });
      await renderEnabled();
      await type("okra and tex-mex");
      expect(await screen.findByRole("button", { name: "Okra" })).toBeTruthy();
      expect(screen.queryByText(/pick any that fit instead/)).toBeNull();
    });
  });
});
