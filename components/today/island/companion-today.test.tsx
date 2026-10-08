// @vitest-environment jsdom
/**
 * The chosen companion on Today (owner, 2026-10-07: "Choose a mascot"; CONTRACT MASCOT #8): the well
 * draws it and speaks its name, and Settings saves the choice as the one `mascot` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import SproutStage from "./Sprout";
import { MASCOT_EVENT, useMascot, wellArt, wellPet } from "./well-pet";
import { SYNCED_EVENT } from "@/lib/sync/client";

type Handle = { userId: string; epoch: number };
const account = vi.hoisted(() => ({ current: { userId: "a", epoch: 1 } as Handle | null }));
const sameAccount = (h: Handle) => account.current?.userId === h.userId && account.current.epoch === h.epoch;
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => account.current,
  assertCurrent: (h: Handle) => { if (!sameAccount(h)) throw new Error("account changed"); },
}));
const store = vi.hoisted(() => ({ settings: { mascot: "sprout" } as Record<string, unknown> }));
vi.mock("@/lib/store", () => ({
  loadStore: () => ({ settings: { ...store.settings } }),
  saveStoreFor: (h: Handle, next: { settings: Record<string, unknown> }) => {
    if (!sameAccount(h)) throw new Error("account changed");
    store.settings = { ...next.settings };
  },
}));
const sync = vi.hoisted(() => ({ calls: [] as unknown[][], fail: false, gate: null as null | ((n: number) => Promise<void>) }));
vi.mock("@/lib/coach/apply-profile", () => ({
  syncProfileSettings: async (...args: unknown[]) => {
    sync.calls.push(args);
    if (sync.gate) await sync.gate(sync.calls.length);
    if (sync.fail) throw new Error("offline");
  },
}));
vi.mock("@/components/settings/use-settings-write", () => ({
  useSettingsWrite: (send: (p: unknown) => Promise<unknown>) => ({
    feedback: { phase: undefined, notice: null, dismiss: () => {} },
    write: (p: unknown) => { void send(p).catch(() => {}); },
  }),
}));

beforeEach(() => {
  store.settings = { mascot: "sprout" }; sync.calls = []; sync.fail = false; sync.gate = null;
  account.current = { userId: "a", epoch: 1 };
});
afterEach(cleanup);

const DAY = { targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 1500, protein: 120, carbs: 150, fat: 50 }, partial: false };

describe("the well's companion", () => {
  it("speaks its name, before the clock and when it cheers", () => {
    expect(wellPet(DAY, null, "today", false, "blueberry").line).toBe("Blu is here with you.");
    expect(wellPet(DAY, 13, "today", true, "mushroom")).toMatchObject({ mood: "joyful", line: "Button cheers: today's log grew." });
    expect(wellPet(DAY, 13, "today", false, "peapod").line).toMatch(/Pod/);
  });

  it("draws Sprout from its well art and the others from their own", () => {
    expect(wellArt("sprout", "content")).toBe("/pet/sprout-content.webp");
    expect(wellArt("blueberry", "sleepy")).toBe("/pet/mascots/blueberry/sleepy.webp");
  });

  it("shows the chosen companion's art and name in the open well", () => {
    render(<MotionConfig reducedMotion="always">
      <SproutStage state={wellPet(DAY, 13, "today", false, "peapod")} glance={null} bounce={0} mascot="peapod" /></MotionConfig>);
    expect(screen.getByRole("button", { name: "Pod. Say hello" })).toBeTruthy();
    expect(screen.getByText("Pod")).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toContain("mascots%2Fpeapod");
  });

  it("follows the phone's choice, and a change made on this phone", () => {
    store.settings = { mascot: "mushroom" };
    const { result } = renderHook(() => useMascot());
    expect(result.current).toBe("mushroom");
    store.settings = { mascot: "blueberry" };
    act(() => { window.dispatchEvent(new Event(MASCOT_EVENT)); });
    expect(result.current).toBe("blueberry");
  });
});

describe("Settings › Your companion", () => {
  it("a companion chosen syncs only the mascot field, keeps it on the phone, and tells an open well", async () => {
    const { default: CompanionSection } = await import("@/components/settings/CompanionSection");
    const told = vi.fn();
    window.addEventListener(MASCOT_EVENT, told);
    render(<MotionConfig reducedMotion="always"><CompanionSection /></MotionConfig>);
    expect(screen.getByRole("button", { name: "Sprout" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Button" })); });
    expect(sync.calls[0][2]).toEqual(["mascot"]);
    expect((sync.calls[0][0] as { mascot: string }).mascot).toBe("mushroom");
    expect(store.settings.mascot).toBe("mushroom");
    expect(told).toHaveBeenCalled();
    window.removeEventListener(MASCOT_EVENT, told);
  });

  it("a save that fails goes back to the companion the account still has", async () => {
    const { default: CompanionSection } = await import("@/components/settings/CompanionSection");
    sync.fail = true;
    render(<MotionConfig reducedMotion="always"><CompanionSection /></MotionConfig>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Blu" })); });
    expect(screen.getByRole("button", { name: "Sprout" }).getAttribute("aria-pressed")).toBe("true");
    expect(store.settings.mascot).toBe("sprout");
  });

  it("a pull moves the picker while nothing is being saved", async () => {
    const { default: CompanionSection } = await import("@/components/settings/CompanionSection");
    render(<MotionConfig reducedMotion="always"><CompanionSection /></MotionConfig>);
    store.settings = { mascot: "peapod" };
    act(() => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    expect(screen.getByRole("button", { name: "Pod" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("sends two quick choices in tap order, and an older one failing late leaves the newer one shown", async () => {
    const { default: CompanionSection } = await import("@/components/settings/CompanionSection");
    const release: Array<{ go: () => void; fail: () => void }> = [];
    sync.gate = () => new Promise<void>((go, fail) => { release.push({ go: () => go(), fail: () => fail(new Error("offline")) }); });
    render(<MotionConfig reducedMotion="always"><CompanionSection /></MotionConfig>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Blu" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Button" })); });
    expect(sync.calls).toHaveLength(1);
    await act(async () => { release[0].fail(); });
    expect(screen.getByRole("button", { name: "Button" }).getAttribute("aria-pressed")).toBe("true");
    expect(sync.calls).toHaveLength(2);
    expect((sync.calls[1][0] as { mascot: string }).mascot).toBe("mushroom");
    await act(async () => { release[1].go(); });
    expect(store.settings.mascot).toBe("mushroom");
    expect(screen.getByRole("button", { name: "Button" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a choice waiting its turn when the account changes is never sent or kept for the next account", async () => {
    const { default: CompanionSection } = await import("@/components/settings/CompanionSection");
    const release: Array<() => void> = [];
    sync.gate = () => new Promise<void>((go) => { release.push(go); });
    render(<MotionConfig reducedMotion="always"><CompanionSection /></MotionConfig>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Blu" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Button" })); });
    account.current = { userId: "b", epoch: 2 };
    await act(async () => { release[0](); });
    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0][1]).toEqual({ userId: "a", epoch: 1 });
    expect(store.settings.mascot).toBe("sprout");
  });
});
