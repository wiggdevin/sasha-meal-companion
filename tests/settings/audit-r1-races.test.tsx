// @vitest-environment jsdom
/**
 * UI audit round 1 (ui-ux-buddy defect mode, 2026-10-07): quick edits on Settings land in tap order,
 * and a section that showed a local edit follows a later sync pull.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { defaultSettings } from "@/lib/store";
import type { Settings, Store } from "@/lib/types";

type Gate = { go: () => void };
const gates = vi.hoisted(() => ({ list: [] as Gate[], hold: false }));
const held = <T,>(value: () => T): Promise<T> => gates.hold
  ? new Promise<T>((resolve) => { gates.list.push({ go: () => resolve(value()) }); })
  : Promise.resolve(value());

const store = vi.hoisted(() => ({ value: null as unknown as Store }));
vi.mock("@/lib/store", async (original) => ({
  ...(await original<typeof import("@/lib/store")>()),
  loadStore: () => store.value,
  saveStore: (next: Store) => { store.value = next; },
  saveStoreFor: (_h: unknown, next: Store) => { store.value = next; },
}));
vi.mock("@/lib/coach/apply-profile", () => ({
  // The pin lands (on the server and the phone) only when its request answers.
  applySetTargets: (action: { proteinG?: number }) => held(() => {
    store.value = { ...store.value, settings: { ...store.value.settings, proteinG: action.proteinG ?? 0 } };
    return { ok: true };
  }),
  applyUpdateProfile: async () => ({ ok: true }),
  syncProfileSettings: async () => {},
}));
vi.mock("@/lib/health-client", () => ({ fetchDaily: async () => ({ days: [] }) }));
vi.mock("@/lib/targets/client", () => ({ fetchTargetState: async () => ({ target: null }) }));
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => null,
}));
const place = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/profile/cuisines-client", () => ({
  savePlaceSetting: (patch: unknown) => held(() => { place.calls.push(patch); }),
}));
vi.mock("@/lib/profile/taste-enabled-client", () => ({ readTasteChipsEnabled: async () => "disabled" }));

afterEach(() => { cleanup(); gates.list = []; gates.hold = false; place.calls = []; });
const release = async (i: number) => { await act(async () => { gates.list[i].go(); }); };

describe("UI audit r1: tap order", () => {
  it("a slow first protein pin never lands after a later one (the shown grams end on the last tap)", async () => {
    store.value = { settings: { ...defaultSettings(), proteinG: 140 } } as unknown as Store;
    const { useSettingsController } = await import("@/components/settings/use-settings-controller");
    const { result } = renderHook(() => useSettingsController());
    await waitFor(() => expect(result.current).not.toBeNull());
    gates.hold = true;
    act(() => { result.current!.setProteinG(150); });
    act(() => { result.current!.setProteinG(155); });
    await waitFor(() => expect(gates.list.length).toBe(1));
    await release(0);
    await waitFor(() => expect(gates.list.length).toBe(2));
    await release(1);
    await waitFor(() => expect((result.current!.store!.settings as Settings).proteinG).toBe(155));
  });

  it("sends a section's edits one after another, in tap order", async () => {
    const { useSettingsWrite } = await import("@/components/settings/use-settings-write");
    gates.hold = true;
    const sent: string[] = [];
    const { result } = renderHook(() => useSettingsWrite<string>((patch) => held(() => { sent.push(patch); })));
    act(() => { result.current.write("first"); result.current.write("second"); });
    await waitFor(() => expect(gates.list.length).toBe(1));
    await release(0);
    await waitFor(() => expect(gates.list.length).toBe(2));
    await release(1);
    expect(sent).toEqual(["first", "second"]);
  });
});

describe("UI audit r1: cuisines follow a sync pull", () => {
  it("after its own edit settles, the section shows a cuisine another device added and keeps it on the next tap", async () => {
    const { default: CuisinesSection } = await import("@/components/settings/CuisinesSection");
    const settings = (cuisines: string[]) => ({ ...defaultSettings(), cuisines }) as unknown as Settings;
    const { rerender } = render(<CuisinesSection settings={settings(["korean"])} />);
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
    await waitFor(() => expect(place.calls).toHaveLength(1));
    // The pull from another device: Caribbean added there.
    rerender(<CuisinesSection settings={settings(["japanese", "korean", "caribbean"])} />);
    expect(screen.getByRole("button", { name: "Caribbean" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Italian" }));
    await waitFor(() => expect(place.calls).toHaveLength(2));
    expect(place.calls[1]).toEqual({ cuisines: ["italian", "japanese", "korean", "caribbean"] });
  });
});
