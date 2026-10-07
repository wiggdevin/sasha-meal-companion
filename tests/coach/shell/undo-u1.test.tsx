// @vitest-environment jsdom
/**
 * U1, the UI half (docs/specs/coach-undo-receipt.md §8.3): the t25r2 arrangement on a second device.
 * Card A offers meal-3; card B defaults to meal-2 with meal-3 pending. A legacy set_slot_meal record
 * bound to meal-3, made by a composed card's tap on device 1, appears on device 2 exactly once, as
 * "Coach change", with no Eggs card and no card guessed from either card. The records are the real
 * `listUndos` (lib/server/coach-undo.ts) output over an in-memory copy of the caller's table, fed
 * into the real transcript through CoachShell.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CoachShell from "@/components/coach/CoachShell";
import type { ChatMessage } from "@/lib/coach/chat-state";
import type { ComposedMeal } from "@/lib/coach/compose";
import { listUndos } from "@/lib/server/coach-undo";

const USER = "aaaaaaaa-0000-4000-8000-00000000000a";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000011";
const RECORD = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const mocks = vi.hoisted(() => ({ getThread: vi.fn(), listCoachUndos: vi.fn() }));
const account = { userId: USER, epoch: 1 };
vi.mock("@/lib/device/account", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/device/account")>(),
  currentAccountOrNull: () => account, isCurrent: () => true,
}));
// Device 2: nothing cached, so no local ledger and no token.
vi.mock("@/lib/coach-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach-client")>(),
  getThread: mocks.getThread, readCache: () => ({ messages: [], actions: [] }), writeCache: vi.fn(),
}));
vi.mock("@/lib/coach/undo-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/undo-client")>(),
  listCoachUndos: mocks.listCoachUndos,
}));

afterEach(() => { cleanup(); mocks.getThread.mockReset(); mocks.listCoachUndos.mockReset(); });

function eggs(slot: string, pending?: string): ComposedMeal {
  const macros = { kcal: 143, protein: 13, carbs: 1, fat: 10 };
  return {
    wish: "eggs", slot,
    items: [{ name: "Eggs", foodRefId: "egg", catalogFoodRevisionId: null, grams: 100, kcalPer100g: 143,
      proteinPer100g: 13, carbsPer100g: 1, fatPer100g: 10, macros, verdict: "allowed" }],
    totals: macros, target: { kcal: 500, protein: 40, carbs: 50, fat: 15 }, flagged: [], fitsTarget: false,
    ...(pending ? { pendingSlots: [{ slot: pending, label: "Meal 3" }] } : {}),
  };
}

/** The caller's RLS-scoped table as PostgREST reads it: own rows, ordered, limited. */
function tableClient(rows: Record<string, unknown>[]) {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const filters: ((row: Record<string, unknown>) => boolean)[] = [(row) => row.user_id === USER];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters.push((row) => row[col] === val); return chain; },
      in: (col: string, vals: unknown[]) => { filters.push((row) => vals.includes(row[col])); return chain; },
      or: () => chain, order: () => chain, limit: () => chain, range: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: (table === "coach_action_undos" ? rows : []).filter((row) => filters.every((f) => f(row))),
        error: null }).then(resolve),
    };
    return chain;
  };
  return { client: { from } as never, reads };
}

it("U1: a legacy composed-card tap shows once on device 2 as Coach change, with no Eggs card", async () => {
  const saved = { id: MESSAGE, role: "assistant", content: "Two ways to have eggs.", seq: 2,
    composed: [eggs("meal-3"), eggs("meal-2", "meal-3")] } as unknown as ChatMessage;
  // Made on device 1 by tapping a composed card: its action id was minted at the tap, so no saved
  // message carries it, and the record is legacy (no receipt).
  const { client, reads } = tableClient([{ id: RECORD, user_id: USER, thread_id: THREAD, message_id: MESSAGE,
    action_id: "tap-meal-3", kind: "set_slot_meal", record_mode: "legacy", source_check: null,
    inverse: { kind: "set_slot_meal", date: "2026-10-05", slot: "meal-3" }, expected_rev: null,
    created_at: "2026-10-05T11:30:00.000Z", undone_at: null, expires_at: "2026-10-12T11:30:00.000Z" }]);
  const page = await listUndos(client, USER, { threadId: THREAD }, NOW);
  expect(reads).not.toContain("coach_messages");
  mocks.listCoachUndos.mockResolvedValue(page.undos);
  mocks.getThread.mockResolvedValue({ thread: { id: THREAD, title: null, kind: "chat", lastMessageAt: null },
    messages: [saved], cleared: true });

  render(<CoachShell userId={USER} threadId={THREAD} onOpenDraft={() => undefined} onThreadSaved={() => undefined} />);

  await waitFor(() => expect(document.querySelectorAll("[data-action-id]")).toHaveLength(1));
  const card = document.querySelector<HTMLElement>("[data-action-id]")!;
  expect(card.dataset.actionId).toBe("tap-meal-3");
  expect(card.querySelector("h3")?.textContent).toBe("Coach change");
  // When the server recorded it, in this phone's zone ("Mon 5 Oct, 12:30" or the like).
  expect(card.textContent).toMatch(/\d{1,2} Oct, \d{2}:\d{2}/);
  expect(card.textContent).not.toMatch(/eggs|meal 2|meal 3/i);
  for (const action of document.querySelectorAll("[data-action-id]")) expect(action.textContent).not.toMatch(/eggs/i);
  // Legacy set_slot_meal: the server cannot undo it, so device 2 offers no Undo.
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.getByText("Done")).toBeTruthy();
});
