// @vitest-environment jsdom
/**
 * Phase 18 W3 UI: the read-only "Eaten often" section (components/EatenOften.tsx). `loadTaste`
 * (lib/foods/taste-client.ts) is mocked so this spec is about what the section draws from a
 * result, not the fetch itself (covered by tests/foods/taste-client.test.ts).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";

const { loadTasteMock } = vi.hoisted(() => ({ loadTasteMock: vi.fn() }));
vi.mock("@/lib/foods/taste-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/foods/taste-client")>();
  return { ...actual, loadTaste: (...args: Parameters<typeof actual.loadTaste>) => loadTasteMock(...args) };
});

const { default: EatenOften } = await import("@/components/EatenOften");
const { TASTE_RULE_REVIEW_COPY } = await import("@/lib/foods/taste-client");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function row(over: {
  key?: string; name?: string; days180?: number; lastOn?: string; favored?: boolean; favorable?: boolean;
  estimated?: boolean;
} = {}) {
  return {
    key: over.key ?? "u:oats", name: over.name ?? "Oats", days180: over.days180 ?? 5,
    lastOn: over.lastOn ?? "2026-10-03", favored: over.favored ?? false, favorable: over.favorable ?? false,
    h: 1, q: 0,
    provenance: {
      match: "universe" as const, estimated: over.estimated ?? false,
      sources: { log: 1, recipe: 0, tick: 0, mixed_dish: 0 }, collapsed: 0,
      choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 },
    },
  };
}

beforeEach(() => { loadTasteMock.mockReset(); });
afterEach(() => { cleanup(); unbindAccount(); });

it("reads nothing before an account is ready", () => {
  render(<EatenOften />);
  expect(loadTasteMock).not.toHaveBeenCalled();
});

it("renders nothing while the read is unavailable", async () => {
  loadTasteMock.mockResolvedValue({ status: "unavailable" });
  markAccountReady(bindAccount(USER_ID));
  const { container } = render(<EatenOften />);
  await waitFor(() => expect(loadTasteMock).toHaveBeenCalled());
  expect(container.firstChild).toBeNull();
});

it("renders nothing when there are no admitted foods", async () => {
  loadTasteMock.mockResolvedValue({ status: "ok", items: [] });
  markAccountReady(bindAccount(USER_ID));
  const { container } = render(<EatenOften />);
  await waitFor(() => expect(loadTasteMock).toHaveBeenCalled());
  expect(container.firstChild).toBeNull();
});

it("shows the eligible-foods path's rule review copy on a 409", async () => {
  loadTasteMock.mockResolvedValue({ status: "rule_review", message: TASTE_RULE_REVIEW_COPY });
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);
  expect(await screen.findByText(TASTE_RULE_REVIEW_COPY)).toBeTruthy();
});

it("renders rows in the server's own order, with singular/plural day copy and an Estimated tag "
  + "only when provenance.estimated is true", async () => {
  loadTasteMock.mockResolvedValue({ status: "ok", items: [
    row({ key: "u:a", name: "Apple", days180: 1, lastOn: "2026-10-03" }),
    row({ key: "u:b", name: "Rice", days180: 5, lastOn: "2026-09-20", estimated: true }),
  ] });
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);

  await screen.findByText("Often eaten");
  expect(screen.getByText("From the last 6 months")).toBeTruthy();
  const metas = screen.getAllByText(/Eaten on/);
  expect(metas).toHaveLength(2);
  expect(metas[0].textContent).toBe("Eaten on 1 day");
  expect(metas[1].textContent).toBe("Eaten on 5 days");
  // Preserved server order: Apple (not estimated) before Rice (estimated) — never re-sorted.
  const apple = screen.getByText("Apple");
  const rice = screen.getByText("Rice");
  expect(apple.compareDocumentPosition(rice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryAllByText("Estimated")).toHaveLength(1);
});

it("renders grouped by aisle, each group under its own header", async () => {
  loadTasteMock.mockResolvedValue({ status: "ok", items: [
    row({ key: "u:r", name: "White rice, cooked" }),
    row({ key: "u:a", name: "Acorn squash, baked" }),
  ] });
  markAccountReady(bindAccount(USER_ID));
  const { container } = render(<EatenOften />);
  await screen.findByText("Acorn squash, baked");
  const groups = [...container.querySelectorAll("[data-aisle]")].map((node) => node.getAttribute("data-aisle"));
  expect(groups).toEqual(["produce", "grains"]);
});

it("caps at six rows, then Show all N opens the rest on the shared Disclosure — no nested scroll", async () => {
  const items = Array.from({ length: 7 }, (_, i) => row({ key: `u:f${i}`, name: `Food ${i}` }));
  loadTasteMock.mockResolvedValue({ status: "ok", items });
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);

  await screen.findByText("Food 0");
  const toggle = screen.getByText("Show all 7").closest("button");
  expect(toggle).not.toBeNull();
  const panel = document.getElementById(toggle!.getAttribute("aria-controls") ?? "");
  expect(panel).not.toBeNull();
  expect(panel!.hasAttribute("inert")).toBe(true);
  expect(within(panel!).getByText("Food 6")).toBeTruthy();
  expect(document.querySelector(".overflow-y-auto, .overflow-auto")).toBeNull();

  fireEvent.click(toggle!);
  expect(panel!.hasAttribute("inert")).toBe(false);
});

it("offers Favor only for a row the server reports favorable and not yet favored", async () => {
  loadTasteMock.mockResolvedValue({ status: "ok", items: [
    row({ key: "u:a", name: "Apple", favorable: true }),
    row({ key: "u:b", name: "Banana", favorable: true, favored: true }),
    row({ key: "u:c", name: "Cocoa", favorable: false }),
  ] });
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);

  await screen.findByText("Apple");
  expect(screen.getByRole("button", { name: "Add Apple to Favorites" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add Banana to Favorites" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add Cocoa to Favorites" })).toBeNull();
});

it("re-reads on SYNCED_EVENT, with no polling in between", async () => {
  loadTasteMock.mockResolvedValue({ status: "ok", items: [row()] });
  markAccountReady(bindAccount(USER_ID));
  render(<EatenOften />);
  await waitFor(() => expect(loadTasteMock).toHaveBeenCalledTimes(1));

  window.dispatchEvent(new Event(SYNCED_EVENT));
  await waitFor(() => expect(loadTasteMock).toHaveBeenCalledTimes(2));
});
