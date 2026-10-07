// @vitest-environment jsdom
/**
 * Seeds, the shop and Sprout's messages on Today, against the care routes (#5): every answer checked
 * at the boundary, quiet on failure, and the well's layer that opens the shop and plays awards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import CareLayer from "./CareLayer";
import { equipCareItem, offeredItems, purchaseCareItem, readCareShop } from "./care-api";
import { noteOf } from "./useCare";
import type { ShopState } from "./shop/shop-state";

// A bound account; the calls go straight to the stubbed fetch with the account header.
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "u1", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init: RequestInit = {}) => fetch(url, init),
  accountJson: (_h: unknown, res: Response) => res.json(),
}));
vi.mock("@/components/today/care/sound", () => ({
  play: vi.fn(), unlockAudio: vi.fn(), readMuted: () => true, silence: vi.fn(), writeMuted: vi.fn(),
}));

const SHOP = { items: [{ id: "bucket-hat", slot: "head", price: 25 }, { id: "glasses", slot: "eyes", price: 30 },
  { id: "jetpack", slot: "body", price: 99 }], owned: ["glasses"], equipped: { eyes: "glasses", body: "jetpack" },
  rev: 3, balance: 42 };
const POINTS = { balance: 42, pending: 2, recent: [{ id: "d1", kind: "day_recorded", delta: 2, localDate: "2026-10-07",
  status: "pending" }] };
const MESSAGES = { messages: [{ id: "m1", type: "accolade", payload: { key: "first-meal", version: 1 },
  createdAt: "2026-10-07T12:00:00Z", readAt: null, dismissedAt: null }] };

type Route = (url: string, init?: RequestInit) => unknown;
let calls: { url: string; init?: RequestInit }[] = [];
function serve(route: Route) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = route(url, init);
    return body === undefined ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(body), { status: 200 });
  }));
}
const normal: Route = (url) => url === "/api/care/shop" ? SHOP : url.startsWith("/api/care/points?date=") ? POINTS
  : url.startsWith("/api/care/messages?") ? MESSAGES : url.startsWith("/api/care/") ? { ok: true } : undefined;

beforeEach(() => serve(normal));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the care routes, from the phone", () => {
  it("reads the shop and Seeds, leaving out what the phone cannot draw", async () => {
    const shop = await readCareShop();
    if (shop === "failed") throw new Error("expected a shop");
    expect(shop.state.balance).toBe(42);
    expect(shop.state.equipped).toEqual({ eyes: "glasses" });
    expect(shop.prices).toEqual({ "bucket-hat": 25, glasses: 30 });
    expect(offeredItems(shop.prices).map((item) => item.id)).toEqual(["bucket-hat", "glasses"]);
    expect(shop.state.ledger[0]).toMatchObject({ kind: "day_recorded", status: "pending" });
  });

  it("is quiet on a failed or malformed answer, never a guess", async () => {
    serve(() => undefined);
    expect(await readCareShop()).toBe("failed");
    serve((url) => url === "/api/care/shop" ? { ...SHOP, balance: "lots" } : POINTS);
    // The phone's own day rides along, so the server settles Seeds on the phone's today.
    expect(await readCareShop()).toBe("failed");
  });

  it("buys through the server with the action id, and maps every answer", async () => {
    const state: ShopState = { balance: 42, owned: [], equipped: {}, rev: 0, receipts: {}, ledger: [] };
    serve(() => ({ status: "applied", receipt: { actionId: "a1", itemId: "bucket-hat", price: 25, balance: 17 } }));
    const bought = await purchaseCareItem(state, "bucket-hat", "a1");
    expect(bought !== "failed" && bought.ok && bought.state.balance).toBe(17);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ itemId: "bucket-hat", actionId: "a1" });
    expect(calls[0].url).toMatch(/^\/api\/care\/purchase\?date=\d{4}-\d{2}-\d{2}$/);
    serve(() => ({ status: "insufficient", short: 8 }));
    expect(await purchaseCareItem(state, "bucket-hat", "a2")).toEqual({ ok: false, code: "insufficient", short: 8 });
    serve(() => ({ status: "conflict", equipped: {}, rev: 4 }));
    expect(await equipCareItem(state, "head", "bucket-hat")).toBe("conflict");
  });
});

describe("messages as notes", () => {
  it("draws an award by its key and drops what it cannot draw", () => {
    const base = { id: "m", createdAt: "2026-10-07T12:00:00Z" };
    expect(noteOf({ ...base, type: "accolade", payload: { key: "first-meal" } })).toMatchObject({ type: "accolade" });
    expect(noteOf({ ...base, type: "accolade", payload: { key: "no-such-award" } })).toBeNull();
    expect(noteOf({ ...base, type: "streak", payload: { text: "Five days.", days: [true, false] } })).toBeNull();
    expect(noteOf({ ...base, type: "gossip", payload: { text: "hi" } })).toBeNull();
  });
});

const layer = () => render(<MotionConfig reducedMotion="always"><button type="button">Elsewhere on Today</button>
  <div><CareLayer active /></div></MotionConfig>);

describe("CareLayer", () => {
  it("shows the Seeds chip, opens the shop over the well, and Escape hands focus back", async () => {
    layer();
    const chip = await screen.findByRole("button", { name: "42 Seeds. Open Sprout's shop" });
    await act(async () => { fireEvent.click(chip); });
    expect(screen.getByRole("dialog", { name: "Sprout's shop" })).toBeTruthy();
    // Focus moves into the shop (the chip is inert under it).
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Sprout's shop" }));
    expect(screen.getByRole("button", { name: "Bucket hat, 25 Seeds" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Jetpack/ })).toBeNull();
    // Modal (Sol r2): nothing outside the shop takes a pointer or the keyboard while it is open.
    const elsewhere = screen.getByText("Elsewhere on Today").closest("button")!;
    expect(elsewhere.inert).toBe(true);
    // Tab wraps inside the shop (Sol r1): from its last stop to its first, and back with Shift.
    const dialog = screen.getByRole("dialog", { name: "Sprout's shop" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const stops = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
    stops[stops.length - 1].focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sprout's shop" })).toBeNull());
    expect(document.activeElement).toBe(chip);
    expect(elsewhere.inert).toBe(false);
  });

  it("stays modal through the shop's closing fade, then hands focus to the chip (Sol r4)", async () => {
    render(<MotionConfig reducedMotion="never"><button type="button">Elsewhere on Today</button>
      <div><CareLayer active /></div></MotionConfig>);
    const chip = await screen.findByRole("button", { name: /Open Sprout's shop/ });
    await act(async () => { fireEvent.click(chip); });
    const elsewhere = screen.getByText("Elsewhere on Today").closest("button")!;
    fireEvent.keyDown(document, { key: "Escape" });
    // Fading out: still modal.
    expect(elsewhere.inert).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sprout's shop" })).toBeNull());
    await waitFor(() => expect(elsewhere.inert).toBe(false));
    expect(document.activeElement).toBe(chip);
  });

  it("never lets a tap inside it reach the card behind (it would fold the well) (Sol r3)", async () => {
    const fold = vi.fn();
    render(<MotionConfig reducedMotion="always"><div onClick={fold} onPointerDown={fold}><CareLayer active /></div></MotionConfig>);
    const chip = await screen.findByRole("button", { name: /Open Sprout's shop/ });
    await act(async () => { fireEvent.click(chip); });
    const dialog = screen.getByRole("dialog", { name: "Sprout's shop" });
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(fold).not.toHaveBeenCalled();
  });

  it("keeps the open shop when a refresh fails (Sol r2)", async () => {
    layer();
    const chip = await screen.findByRole("button", { name: /Open Sprout's shop/ });
    await act(async () => { fireEvent.click(chip); });
    serve(() => undefined);
    // A purchase that fails asks for a refresh; the refresh fails too.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Bucket hat, 25 Seeds" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Buy the bucket hat for 25 Seeds" })); });
    expect(screen.getByRole("dialog", { name: "Sprout's shop" })).toBeTruthy();
  });

  it("reads points before the shop, so the shop carries the settled balance (Sol r1)", async () => {
    layer();
    await screen.findByRole("button", { name: /Open Sprout's shop/ });
    const order = calls.map((c) => c.url).filter((u) => u.startsWith("/api/care/points") || u === "/api/care/shop");
    expect(order[0]).toMatch(/^\/api\/care\/points/);
    expect(order[1]).toBe("/api/care/shop");
  });

  it("forgets the last visit when the well folds, and shows no old note if the inbox then fails", async () => {
    const view = render(<MotionConfig reducedMotion="always"><CareLayer active /></MotionConfig>);
    await screen.findByRole("button", { name: "Watch" });
    view.rerender(<MotionConfig reducedMotion="always"><CareLayer active={false} /></MotionConfig>);
    serve(() => undefined);
    view.rerender(<MotionConfig reducedMotion="always"><CareLayer active /></MotionConfig>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Watch" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open Sprout's shop/ })).toBeNull();
  });

  it("plays an award from its note, modal, marks it seen and read, and returns focus to the chip", async () => {
    layer();
    const chip = await screen.findByRole("button", { name: /Open Sprout's shop/ });
    const watch = await screen.findByRole("button", { name: "Watch" });
    await act(async () => { fireEvent.click(watch); });
    expect(screen.getByRole("dialog", { name: /Award: First meal/ }).getAttribute("aria-modal")).toBe("true");
    // Modal (Sol r3): the rest of Today is out of reach while it plays.
    expect(screen.getByText("Elsewhere on Today").closest("button")!.inert).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Award/ })).toBeNull());
    expect(document.activeElement).toBe(chip);
    expect(screen.getByText("Elsewhere on Today").closest("button")!.inert).toBe(false);
    expect(calls.some((c) => c.url === "/api/care/accolades/seen" && String(c.init?.body).includes("first-meal"))).toBe(true);
    expect(calls.some((c) => c.url === "/api/care/messages/m1/read")).toBe(true);
  });

  it("shows nothing when the server cannot answer", async () => {
    serve(() => undefined);
    layer();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: /Seeds/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Watch" })).toBeNull();
  });

  it("reads nothing while the well is folded or not on today", () => {
    render(<CareLayer active={false} />);
    expect(calls).toHaveLength(0);
  });
});
