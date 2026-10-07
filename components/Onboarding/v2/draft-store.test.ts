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
