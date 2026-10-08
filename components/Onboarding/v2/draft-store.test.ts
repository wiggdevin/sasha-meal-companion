// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft } from "./draft-store";

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  bindAccount("11111111-1111-4111-8111-111111111111");
});

afterEach(() => {
  vi.restoreAllMocks();
  unbindAccount();
});

describe("onboarding draft store", () => {
  it("round-trips a saved draft", async () => {
    expect(await loadOnboardingDraft()).toBeNull();
    await saveOnboardingDraft({ beat: "facts", settings: { goal: "recomp", heightCm: 170 } });
    const loaded = await loadOnboardingDraft();
    expect(loaded?.beat).toBe("facts");
    expect(loaded?.settings).toEqual({ goal: "recomp", heightCm: 170 });
    expect(typeof loaded?.savedAt).toBe("string");
  });

  it("overwrites the previous draft on a later save", async () => {
    await saveOnboardingDraft({ beat: "facts", settings: { goal: "recomp" } });
    await saveOnboardingDraft({ beat: "foods", settings: { goal: "recomp", heightCm: 180 } });
    const loaded = await loadOnboardingDraft();
    expect(loaded?.beat).toBe("foods");
    expect(loaded?.settings.heightCm).toBe(180);
  });

  it("clears the draft", async () => {
    await saveOnboardingDraft({ beat: "facts", settings: {} });
    await clearOnboardingDraft();
    expect(await loadOnboardingDraft()).toBeNull();
  });

  // GPT-6 Sol round-1 BLOCK: a single shared "current" key let a second account on the same
  // browser resume, and overwrite, the first account's draft.
  it("keeps one account's draft invisible to, and un-overwritten by, a second account", async () => {
    await saveOnboardingDraft({ beat: "reward", settings: { goal: "lose_fat", heightCm: 165 } });
    unbindAccount();
    bindAccount("22222222-2222-4222-8222-222222222222");
    expect(await loadOnboardingDraft()).toBeNull();
    await saveOnboardingDraft({ beat: "facts", settings: { goal: "maintain" } });

    unbindAccount();
    bindAccount("11111111-1111-4111-8111-111111111111");
    const loaded = await loadOnboardingDraft();
    expect(loaded?.beat).toBe("reward");
    expect(loaded?.settings.heightCm).toBe(165);
  });

  it("never saves or loads a draft with no account bound", async () => {
    unbindAccount();
    await saveOnboardingDraft({ beat: "facts", settings: { goal: "recomp" } });
    expect(await loadOnboardingDraft()).toBeNull();
  });

  it("never throws when IndexedDB is unavailable", async () => {
    const original = globalThis.indexedDB;
    // Simulating a private window / disabled IndexedDB.
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    await expect(saveOnboardingDraft({ beat: "facts", settings: {} })).resolves.toBeUndefined();
    await expect(loadOnboardingDraft()).resolves.toBeNull();
    await expect(clearOnboardingDraft()).resolves.toBeUndefined();
    (globalThis as { indexedDB: IDBFactory }).indexedDB = original;
  });
});

// GPT-6 Sol BLOCK (onb2-p0): the save's one target request id survives a failed attempt, a
// reload and the beat autosave, and a changed request gets a new one.
describe("the onboarding save's target request id", () => {
  it("is the same id for the same request, after a reload and an autosave", async () => {
    const { onboardingTargetRequestId } = await import("./draft-store");
    const first = await onboardingTargetRequestId("request-a");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await saveOnboardingDraft({ beat: "facts", settings: { goal: "recomp" } });
    expect((await loadOnboardingDraft())?.targetRequest).toEqual({ id: first, key: "request-a" });
    vi.resetModules(); // a reload: nothing held in memory
    (await import("@/lib/device/account")).bindAccount("11111111-1111-4111-8111-111111111111");
    const reloaded = await import("./draft-store");
    expect(await reloaded.onboardingTargetRequestId("request-a")).toBe(first);
  });

  it("is a new id for a changed request, and the draft's clear forgets it", async () => {
    const { onboardingTargetRequestId, clearOnboardingDraft: clear } = await import("./draft-store");
    const a = await onboardingTargetRequestId("request-a");
    const b = await onboardingTargetRequestId("request-b");
    expect(b).not.toBe(a);
    await clear();
    expect(await onboardingTargetRequestId("request-b")).not.toBe(b);
  });

  it("keeps the same id for a retry after midnight (final Sol review BLOCK)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { onboardingTargetRequestId, onboardingTargetRequestKey } = await import("./draft-store");
      const state = { goal: "lose_fat", heightCm: 170 };
      const safety = { pregnancy: null, clinicianDiet: false, conditionText: null };
      vi.setSystemTime(new Date("2026-10-08T23:59:50"));
      const before = await onboardingTargetRequestId(onboardingTargetRequestKey(state, safety));
      vi.setSystemTime(new Date("2026-10-09T00:00:10"));
      expect(await onboardingTargetRequestId(onboardingTargetRequestKey(state, safety))).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
