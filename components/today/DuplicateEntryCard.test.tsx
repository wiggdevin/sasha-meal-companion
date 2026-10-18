// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetTestAccount } from "@/tests/helpers/account";
import type { OpenDuplicateGroup } from "@/lib/duplicates/read";

const state = vi.hoisted(() => ({ groups: [] as OpenDuplicateGroup[] }));
const actions = vi.hoisted(() => ({
  scheduled: [] as unknown[][],
  keepBoth: vi.fn(async (..._args: unknown[]) => "queued"),
  undoKeepBoth: vi.fn(async (..._args: unknown[]) => "queued"),
  undoMerge: vi.fn((..._args: unknown[]) => true),
}));
vi.mock("@/lib/duplicates/read", async (original) => ({
  ...(await original<object>()),
  readOpenDuplicateGroups: vi.fn(async () => state.groups),
}));
vi.mock("@/lib/duplicates/actions", () => ({
  ...actions,
  MERGE_PENDING_EVENT: "test:merge-pending",
  isMergeHeld: () => false,
  scheduleMerge: vi.fn((...args: unknown[]) => {
    actions.scheduled.push(args);
    return { undo: () => actions.undoMerge() };
  }),
}));

import DuplicateEntryCard from "./DuplicateEntryCard";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";

/** Today's page: one feedback, one toast, shared with the card. */
function SharedToast() {
  const feedback = useActionFeedback();
  return <>
    <DuplicateEntryCard date="2026-10-08" extras={[]} feedback={feedback} />
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </>;
}

const GROUP: OpenDuplicateGroup = {
  group: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", localDate: "2026-10-08", fingerprint: "ab".repeat(32),
    slot: "meal-2", state: "open", rev: 1 },
  members: [
    { entryId: "e1", at: "2026-10-08T12:31:00", name: "Lunch", itemNames: ["Chicken thigh", "Rice"], kcal: 540 },
    { entryId: "e2", at: "2026-10-08T12:38:00", name: "Lunch", itemNames: ["Chicken thigh", "Rice"], kcal: null },
  ],
};

async function mount(groups: OpenDuplicateGroup[]) {
  state.groups = groups;
  await act(async () => { render(<DuplicateEntryCard date="2026-10-08" extras={[]} />); });
}

beforeEach(async () => {
  await resetTestAccount();
  actions.scheduled.length = 0;
  for (const fn of [actions.keepBoth, actions.undoKeepBoth]) {
    fn.mockReset(); fn.mockImplementation(async () => "queued");
  }
  actions.undoMerge.mockReset(); actions.undoMerge.mockImplementation(() => true);
});
afterEach(() => cleanup());

describe("DuplicateEntryCard", () => {
  it("hidden: renders nothing while no group is open", async () => {
    await mount([]);
    expect(screen.queryByTestId("duplicate-entry-card")).toBeNull();
  });

  it("open: shows both entries with time, foods and kcal, and named controls", async () => {
    await mount([GROUP]);
    const card = await screen.findByRole("region", { name: "These look like the same meal" });
    expect(card.textContent).toContain("Logged twice?");
    expect(card.textContent).toContain("12:31 pm");
    expect(card.textContent).toContain("12:38 pm");
    expect(card.textContent).toContain("Chicken thigh & Rice");
    expect(card.textContent).toContain("540 kcal");
    expect(card.textContent).toContain("kcal pending");
    expect(screen.getByRole("button", { name: "Keep both entries from 12:31 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge into one entry, keeping the 12:31 pm entry" })).toBeTruthy();
  });

  it("one card per open group", async () => {
    await mount([GROUP, { ...GROUP, group: { ...GROUP.group, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }]);
    expect(screen.getAllByTestId("duplicate-entry-card")).toHaveLength(2);
  });

  it("kept with undo: Keep both queues the decision, and Undo reopens it", async () => {
    await mount([GROUP]);
    state.groups = [];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Keep both entries/ })); });
    expect(actions.keepBoth).toHaveBeenCalledWith(expect.objectContaining({ userId: expect.any(String) }), GROUP.group.id);
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(screen.getByText("Kept both entries.")).toBeTruthy();
    await act(async () => { fireEvent.click(undo); });
    expect(actions.undoKeepBoth).toHaveBeenCalledWith(expect.anything(), GROUP.group.id);
  });

  it("with the page's feedback, its Undo shows in the page's one toast, never a second one (UI audit 2026-10-18)", async () => {
    state.groups = [GROUP];
    await act(async () => { render(<SharedToast />); });
    state.groups = [];
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Merge into one entry/ })); });
    expect(screen.getAllByText("Merged into one entry.")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(actions.undoMerge).toHaveBeenCalledTimes(1);
  });

  it("merging with undo: Merge holds the merge for this group, and Undo cancels it exactly", async () => {
    await mount([GROUP]);
    state.groups = [];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Merge into one entry/ })); });
    expect(actions.scheduled).toEqual([[expect.objectContaining({ userId: expect.any(String) }), GROUP]]);
    expect(screen.getByText("Merged into one entry.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("duplicate-entry-card")).toBeNull());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(actions.undoMerge).toHaveBeenCalledTimes(1);
  });

  it("failed: a Keep both that does not save says so and keeps the card", async () => {
    actions.keepBoth.mockImplementation(async () => { throw new Error("offline"); });
    await mount([GROUP]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Keep both entries/ })); });
    expect(await screen.findByText("That did not save. Try again.")).toBeTruthy();
    expect(screen.getByTestId("duplicate-entry-card")).toBeTruthy();
  });

  it("open: Today mounts the card between the Day card and the day's nutrients", () => {
    const page = readFileSync("app/page.tsx", "utf8");
    const card = page.indexOf("<DuplicateEntryCard date={viewedDate} extras={resolved.extras} feedback={todayFeedback} />");
    expect(card).toBeGreaterThan(page.indexOf("<DayCard"));
    expect(card).toBeLessThan(page.indexOf("<DayNutrients"));
  });
});
