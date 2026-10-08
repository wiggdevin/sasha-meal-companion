// @vitest-environment jsdom
/**
 * The food-group confirm on a coach Eats/Avoid card (PR #368): shown only when the advice asks for
 * confirmation and names a group, saved on "Use as …" with the button's own "Saved", dismissed by
 * "Keep as …" with no write, re-read after a refusal, locked after "Saved", and focus handed to the
 * card's Undo when the question leaves.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ confirm: vi.fn(), pref: vi.fn() }));
vi.mock("@/lib/foods/role-confirm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/foods/role-confirm-client")>()),
  confirmFoodRole: mocked.confirm,
}));
vi.mock("@/lib/foods/prefs-client", () => ({ currentPrefStatus: mocked.pref }));

import CoachActionCard, { type CoachActionStatus } from "@/components/CoachActionCard";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import type { CoachAction } from "@/lib/coach/actions";

const REF = "3f1b1a2c-0000-4000-8000-0000000000f1";
const REASON = "The food is chiefly the meal's fat source.";

function action(advice: Record<string, unknown> = {}, name = "Tahini"): CoachAction {
  return {
    kind: "add_to_eats", actionId: "turn-1", flagged: [], name, foodRefId: REF,
    catalogFoodRevisionId: 7, kcalPer100g: 595, proteinPer100g: 17, carbsPer100g: 21, fatPer100g: 54,
    verdict: "allowed",
    roleAdvice: { foodRefId: REF, suggestedRole: "fat_source", proposedRole: "fat", currentRole: null,
      reason: REASON, confidence: 0.93, requiresConfirmation: true, ...advice },
  } as unknown as CoachAction;
}

function card(a: CoachAction = action(), status: CoachActionStatus = "applied") {
  return render(<MotionConfig reducedMotion="always">
    <CoachActionCard action={a} status={status} canUndo onRetry={() => {}} onUndo={() => {}} />
  </MotionConfig>);
}

beforeEach(() => {
  localStorage.clear();
  bindAccount("user-a");
  mocked.confirm.mockReset();
  mocked.pref.mockReset().mockResolvedValue({ status: "eats", note: null });
});

afterEach(() => { cleanup(); unbindAccount(); });

describe("role confirm on the coach card", () => {
  it("asks in place with the reason once the mirror read has answered", async () => {
    let answer!: (value: unknown) => void;
    mocked.pref.mockReturnValueOnce(new Promise((done) => { answer = done; }));
    card(action({}, "tahini"));
    expect(screen.queryByText("Use Tahini as fat?")).toBeNull();
    await act(async () => { answer({ status: "eats", note: null }); });
    expect(screen.getByText("Use Tahini as fat?")).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use as fat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep as is" })).toBeTruthy();
  });

  it("names the current group on the keep button", async () => {
    card(action({ currentRole: "carb" }));
    expect(await screen.findByRole("button", { name: "Keep as carbs" })).toBeTruthy();
  });

  it.each([
    ["no confirmation required", action({ requiresConfirmation: false }), "applied"],
    ["no proposed role", action({ proposedRole: null }), "applied"],
    ["the list change still applying", action(), "pending"],
  ] as const)("stays hidden with %s", async (_label, a, status) => {
    card(a, status);
    await act(async () => {});
    expect(screen.queryByText("Use Tahini as fat?")).toBeNull();
  });

  it("stays hidden when the food already holds the proposed group", async () => {
    mocked.pref.mockResolvedValue({ status: "eats", note: null, role: "fat" });
    card();
    await waitFor(() => expect(screen.queryByText("Use Tahini as fat?")).toBeNull());
  });

  it("saves on yes and confirms in the button", async () => {
    mocked.confirm.mockResolvedValueOnce({ status: "saved", role: "fat" });
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    expect(mocked.confirm).toHaveBeenCalledWith(expect.objectContaining({
      foodRefId: REF, name: "Tahini", proposedRole: "fat", currentRole: null,
    }));
    expect(use.getAttribute("data-status")).toBe("success");
    expect(screen.getAllByRole("status").some((node) => node.textContent === "Saved")).toBe(true);
  });

  it("locks every action after the first success, so a double tap writes once", async () => {
    mocked.confirm.mockResolvedValue({ status: "saved", role: "fat" });
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    await act(async () => { fireEvent.click(use); });
    expect(mocked.confirm).toHaveBeenCalledTimes(1);
    expect(use.getAttribute("data-status")).toBe("success");
    expect(screen.queryByText("Could not save the food group.")).toBeNull();
    expect((screen.getByRole("button", { name: "Keep as is" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hands focus to Undo when the saved question folds away", async () => {
    mocked.confirm.mockResolvedValueOnce({ status: "saved", role: "fat" });
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    use.focus();
    await act(async () => { fireEvent.click(use); });
    await waitFor(() => expect(screen.queryByText("Use Tahini as fat?")).toBeNull(), { timeout: 4000 });
    expect(document.activeElement?.textContent).toBe("Undo");
  });

  it("keeps without a write and folds away", async () => {
    card();
    const keep = await screen.findByRole("button", { name: "Keep as is" });
    keep.focus();
    fireEvent.click(keep);
    expect(mocked.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Use Tahini as fat?")).toBeNull());
    expect(document.activeElement?.textContent).toBe("Undo");
    cleanup();
    card();
    await act(async () => {});
    expect(screen.queryByText("Use Tahini as fat?")).toBeNull();
  });

  it("re-reads after a 409 and shows the fresh group in a Notice, not a failed button", async () => {
    mocked.confirm.mockResolvedValueOnce({ status: "changed", fresh: { status: "eats", role: "carb" } });
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    expect(use.getAttribute("data-status")).toBeNull();
    expect(screen.getByText("This food's group changed. Check it again.")).toBeTruthy();
    expect(screen.getByText("It is now carbs in Favorites.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep as carbs" })).toBeTruthy();

    mocked.confirm.mockResolvedValueOnce({ status: "saved", role: "fat" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use as fat" })); });
    expect(mocked.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ currentRole: "carb" }));
  });

  it.each([
    ["no preference row (404)", "no_preference"],
    ["membership_required (409)", "membership_required"],
  ])("stops offering Use for %s", async (_label, code) => {
    mocked.confirm.mockResolvedValueOnce({ status: "not_member", code, fresh: null });
    card(action({ currentRole: "carb" }));
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    expect(screen.getByText("This food isn't in Favorites or Avoids.")).toBeTruthy();
    expect(screen.queryByText("This food's group changed. Check it again.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use as fat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep as is" })).toBeTruthy();
  });

  it("says a still-syncing food in a Notice with the button at rest", async () => {
    mocked.confirm.mockResolvedValueOnce({ status: "not_synced", fresh: { status: "eats", role: null } });
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    expect(use.getAttribute("data-status")).toBeNull();
    expect(screen.getByText("This food is still syncing.")).toBeTruthy();
  });

  it("says a failed save in a Notice", async () => {
    mocked.confirm.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    card();
    const use = await screen.findByRole("button", { name: "Use as fat" });
    await act(async () => { fireEvent.click(use); });
    expect(use.getAttribute("data-status")).toBe("error");
    expect(screen.getByText("Could not save the food group.")).toBeTruthy();
  });

  it("writes the food's display name in the question", async () => {
    card(action({}, "tahini"));
    expect(await screen.findByText("Use Tahini as fat?")).toBeTruthy();
  });
});
