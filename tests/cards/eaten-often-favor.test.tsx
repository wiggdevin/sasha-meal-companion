// @vitest-environment jsdom
/**
 * Phase 18 D6: the "Favor" tap on the Eaten often section (components/EatenOften.tsx). The read
 * (`loadTaste`), the write (`favorTasteKey`), the sync pass and the rules epoch are mocked, so this
 * spec is about what the section does with each answer; the answers themselves are
 * tests/foods/favor-client.test.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";

const { loadTasteMock, favorMock, syncMock, revisionMock } = vi.hoisted(() => ({
  loadTasteMock: vi.fn(), favorMock: vi.fn(), syncMock: vi.fn(), revisionMock: vi.fn(),
}));
vi.mock("@/lib/foods/taste-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/taste-client")>();
  return { ...actual, loadTaste: (...args: unknown[]) => loadTasteMock(...args) };
});
vi.mock("@/lib/foods/favor-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/favor-client")>();
  return { ...actual, favorTasteKey: (...args: unknown[]) => favorMock(...args) };
});
vi.mock("@/lib/sync/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/client")>();
  return { ...actual, syncOnce: (...args: unknown[]) => syncMock(...args) };
});
vi.mock("@/lib/foods/rules-epoch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/rules-epoch")>();
  return { ...actual, noteRulesRevision: (...args: unknown[]) => revisionMock(...args) };
});

const { default: EatenOften } = await import("@/components/EatenOften");
const { FAVOR_COPY } = await import("@/lib/foods/favor-client");
const { TASTE_RULE_REVIEW_COPY } = await import("@/lib/foods/taste-client");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function row(over: { favored?: boolean; favorable?: boolean } = {}) {
  return {
    key: "u:oats", name: "Oats", days180: 5, lastOn: "2026-10-03",
    favored: over.favored ?? false, favorable: over.favorable ?? true, h: 1, q: 0,
    provenance: {
      match: "universe" as const, estimated: false,
      sources: { log: 1, recipe: 0, tick: 0, mixed_dish: 0 }, collapsed: 0,
      choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 },
    },
  };
}

const ok = (...items: ReturnType<typeof row>[]) => ({ status: "ok", items });
const status = () => screen.getByRole("status");

beforeEach(() => {
  loadTasteMock.mockReset(); favorMock.mockReset(); syncMock.mockReset(); revisionMock.mockReset();
  syncMock.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); unbindAccount(); });

async function mountWithOats() {
  loadTasteMock.mockResolvedValue(ok(row()));
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);
  return screen.findByRole("button", { name: "Add Oats to Favorites" });
}

it("favors on one tap: shows it in flight, notes the revision, pulls, re-reads, and the button goes", async () => {
  const button = await mountWithOats();
  let finish!: (value: unknown) => void;
  favorMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

  fireEvent.click(button);
  expect(favorMock).toHaveBeenCalledWith("u:oats", { account: expect.objectContaining({ userId: USER_ID }) });
  const inFlight = screen.getByRole("button", { name: "Add Oats to Favorites" }) as HTMLButtonElement;
  expect(inFlight.getAttribute("aria-busy")).toBe("true");
  expect(inFlight.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add Oats to Favorites" }));
  expect(favorMock).toHaveBeenCalledTimes(1);

  loadTasteMock.mockResolvedValue(ok(row({ favored: true })));
  await act(async () => { finish({ status: "favored", rulesRevision: 4 }); });

  await waitFor(() => expect(screen.queryByRole("button", { name: "Add Oats to Favorites" })).toBeNull());
  expect(status().textContent).toBe(FAVOR_COPY.favored);
  expect(revisionMock).toHaveBeenCalledWith(4, USER_ID);
  expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
  expect(loadTasteMock).toHaveBeenCalledTimes(2);
});

it.each([
  ["blocked", FAVOR_COPY.blocked],
  ["busy", FAVOR_COPY.busy],
  ["failed", FAVOR_COPY.failed],
] as const)("on %s: says so, keeps the button, writes nothing else and does not re-read", async (outcome, copy) => {
  const button = await mountWithOats();
  favorMock.mockResolvedValue({ status: outcome });

  fireEvent.click(button);

  await waitFor(() => expect(status().textContent).toBe(copy));
  expect(screen.getByText(copy, { selector: "[aria-hidden='true']" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add Oats to Favorites" }) as HTMLButtonElement).disabled).toBe(false);
  expect(syncMock).not.toHaveBeenCalled();
  expect(revisionMock).not.toHaveBeenCalled();
  expect(loadTasteMock).toHaveBeenCalledTimes(1);
});

it("on rules_changed: says so and re-reads the list so it can be offered again", async () => {
  const button = await mountWithOats();
  favorMock.mockResolvedValue({ status: "changed" });

  fireEvent.click(button);

  await waitFor(() => expect(status().textContent).toBe(FAVOR_COPY.changed));
  await waitFor(() => expect(loadTasteMock).toHaveBeenCalledTimes(2));
  expect(syncMock).not.toHaveBeenCalled();
});

it("on unknown_key: re-reads quietly, and the gone row leaves the list", async () => {
  const button = await mountWithOats();
  favorMock.mockResolvedValue({ status: "gone" });
  loadTasteMock.mockResolvedValue(ok({ ...row(), key: "u:rice", name: "Rice" }));

  fireEvent.click(button);

  await screen.findByText("Rice");
  expect(screen.queryByText("Oats")).toBeNull();
  expect(status().textContent).toBe("");
});

it("on rule_review_required: re-reads, and the section shows the rule-review notice", async () => {
  const button = await mountWithOats();
  favorMock.mockResolvedValue({ status: "rule_review" });
  loadTasteMock.mockResolvedValue({ status: "rule_review", message: TASTE_RULE_REVIEW_COPY });

  fireEvent.click(button);

  expect(await screen.findByText(TASTE_RULE_REVIEW_COPY)).toBeTruthy();
});

it("drops the answer when the account changed while the write was in flight", async () => {
  const button = await mountWithOats();
  favorMock.mockRejectedValue(new Error("AccountChanged"));

  fireEvent.click(button);

  await waitFor(() => expect((screen.getByRole("button", { name: "Add Oats to Favorites" }) as HTMLButtonElement).disabled).toBe(false));
  expect(status().textContent).toBe("");
  expect(syncMock).not.toHaveBeenCalled();
});
