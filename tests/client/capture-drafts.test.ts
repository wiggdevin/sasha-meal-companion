import { beforeEach, describe, expect, it } from "vitest";
import {
  captureInputKey, clearDraft, draftForInput, draftPrefix, draftSaveWarning, loadDraft, saveDraft, type DraftStore,
} from "@/lib/capture/drafts";
import { bindAccount, unbindAccount } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Phase 9 §0.4: drafts live under the bound account's own prefix. */
let DRAFT_PREFIX = "";
beforeEach(() => {
  unbindAccount();
  bindAccount(A);
  DRAFT_PREFIX = draftPrefix()!;
});
import type { ProposeResponse } from "@/lib/capture/types";

function fakeStore(onSet?: () => void): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { onSet?.(); map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function draft(id: string, note = "two eggs"): ProposeResponse {
  return {
    draftId: id, method: "text", notes: [note], spend: { usedToday: 3, softCap: 30 },
    items: [{
      seq: 1, label: "Egg, whole, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
      catalogFoodRevisionId: 910, grams: 100, qty: 2, unit: "each", portionId: 3,
      confidence: 0.82, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
    }],
  };
}

describe("drafts per account (Phase 9 §0.4)", () => {
  it("files a draft under smc:u:<userId>:draft: and never shows it to another account", () => {
    const store = fakeStore();
    expect(DRAFT_PREFIX).toBe(`smc:u:${A}:draft:`);
    saveDraft(draft("d1"), store, new Date(), "text:two eggs");
    bindAccount(B);
    expect(loadDraft("d1", store)).toBeNull();
    expect(draftForInput("text:two eggs", store)).toBeNull();
  });

  it("keeps nothing when no account is bound", () => {
    unbindAccount();
    expect(saveDraft(draft("d1"), fakeStore())).toBe("unavailable");
  });
});

describe("drafts in localStorage", () => {
  it("round-trips a draft under smc:draft:<draftId>", () => {
    const store = fakeStore();
    expect(saveDraft(draft("d1"), store)).toBe("ok");
    expect([...store.map.keys()]).toEqual([`${DRAFT_PREFIX}d1`]);
    expect(loadDraft("d1", store)?.items[0].grams).toBe(100);
  });

  it("answers null for an id it has never held", () => {
    expect(loadDraft("nope", fakeStore())).toBeNull();
  });

  it("answers null rather than throwing on a corrupt value", () => {
    const store = fakeStore();
    store.setItem(`${DRAFT_PREFIX}d1`, "{not json");
    expect(loadDraft("d1", store)).toBeNull();
  });

  it("clears the one key it was given", () => {
    const store = fakeStore();
    saveDraft(draft("d1"), store);
    saveDraft(draft("d2"), store);
    clearDraft("d1", store);
    expect(loadDraft("d1", store)).toBeNull();
    expect(loadDraft("d2", store)).not.toBeNull();
  });

  it("refuses a draft over 64 KB and writes nothing", () => {
    const store = fakeStore();
    const big = draft("d1", "x".repeat(70_000));
    expect(saveDraft(big, store)).toBe("too_large");
    expect(store.map.size).toBe(0);
  });

  it("reports unavailable when the store throws, and does not throw itself", () => {
    const store = fakeStore(() => { throw new Error("QuotaExceededError"); });
    expect(saveDraft(draft("d1"), store)).toBe("unavailable");
  });

  // A032: a duplicate answer shows THIS input's draft, never another capture's.
  it("recovers the draft saved for the same input after a duplicate answer", () => {
    const store = fakeStore();
    saveDraft(draft("mine"), store, new Date("2026-09-11T10:00:00.000Z"), "text:black coffee");
    saveDraft(draft("other"), store, new Date("2026-09-11T10:04:00.000Z"), "text:toast");
    saveDraft(draft("unkeyed"), store, new Date("2026-09-11T10:05:00.000Z"));
    expect(draftForInput("text:black coffee", store)?.draftId).toBe("mine");
  });

  it("finds no draft once that input's draft was committed, whatever else is held", () => {
    const store = fakeStore();
    saveDraft(draft("abandoned"), store, new Date("2026-09-11T10:00:00.000Z"), "text:toast");
    saveDraft(draft("logged"), store, new Date("2026-09-11T10:04:00.000Z"), "text:black coffee");
    clearDraft("logged", store);
    expect(draftForInput("text:black coffee", store)).toBeNull();
    expect(draftForInput(null, store)).toBeNull();
  });

  it("keys the same input the same way, and different inputs apart", async () => {
    expect(await captureInputKey({ method: "text", text: " Black coffee " }))
      .toBe(await captureInputKey({ method: "text", text: "black coffee" }));
    const a = await captureInputKey({ method: "photo", blob: new Blob(["one"]) });
    expect(a).toBe(await captureInputKey({ method: "photo", blob: new Blob(["one"]) }));
    expect(a).not.toBe(await captureInputKey({ method: "photo", blob: new Blob(["two"]) }));
  });

  it("has no store to use on the server and says so", () => {
    expect(saveDraft(draft("d1"), null)).toBe("unavailable");
    expect(loadDraft("d1", null)).toBeNull();
    expect(draftForInput("text:x", null)).toBeNull();
  });
});

describe("draftSaveWarning", () => {
  it("has nothing to tell her when the draft saved fine", () => {
    expect(draftSaveWarning("ok")).toBeNull();
  });

  it("warns her when the draft was too big to save on her phone", () => {
    expect(draftSaveWarning("too_large")).toEqual(expect.any(String));
  });

  it("warns her when the phone's storage was unavailable", () => {
    expect(draftSaveWarning("unavailable")).toEqual(expect.any(String));
  });
});
