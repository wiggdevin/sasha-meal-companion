import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyEdits, canSave, captureMedia, captureText, commitDraft, mapCaptureError, PROPOSE_URL,
  SIGN_URL } from "@/lib/capture-client";
import { logCommitRequestSchema } from "@/lib/log/contract";
import { commitNutritionUnchecked } from "@/lib/nutrition-display";
import type { ProposeResponse } from "@/lib/capture/types";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const CTX = { localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2" as const };

const DRAFT: ProposeResponse = {
  draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b10", method: "text", notes: [],
  spend: { usedToday: 4, softCap: 30 },
  items: [{
    seq: 1, label: "Egg, whole, raw", foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodRevisionId: 910, grams: 100, qty: 2, unit: "each", portionId: 3,
    confidence: 0.82, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
  }],
};

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("captureText", () => {
  it("posts the text propose body and returns the draft", async () => {
    const fetchFn = jsonFetch(200, DRAFT);
    const out = await captureText("  two eggs and rice  ", { ...CTX, fetchFn });
    // `run` is this capture's own timing handle, which the commit closes (Grok pass 5, LOW).
    expect(out).toMatchObject({ kind: "draft", draft: DRAFT });
    expect(out.kind === "draft" && out.run?.path).toBe("text");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(PROPOSE_URL);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      method: "text", localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2",
      text: "two eggs and rice",
    });
  });

  it("refuses an empty box without spending a call", async () => {
    const fetchFn = jsonFetch(200, DRAFT);
    const out = await captureText("   ", { ...CTX, fetchFn });
    expect(out).toMatchObject({ kind: "error", status: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a lost connection to the search fallback line", async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(captureText("rice", { ...CTX, fetchFn })).resolves.toMatchObject({
      kind: "error", status: 0, message: "Capture did not answer. Try search.",
    });
  });
});

describe("the spec status table", () => {
  it("says the cap is reached at 429 spend_cap", () => {
    expect(mapCaptureError(429, "spend_cap")).toEqual({
      kind: "error", status: 429, message: "Daily capture limit reached",
    });
  });

  it("points at search when the provider is down", () => {
    expect(mapCaptureError(503, "provider_unavailable")).toEqual({
      kind: "error", status: 503, message: "Capture is resting, try search",
    });
  });

  it("opens the sheet with zero items on 422", () => {
    expect(mapCaptureError(422, "schema_invalid").kind).toBe("empty");
  });

  it("sends a 409 back to the draft she already holds", () => {
    expect(mapCaptureError(409, "duplicate_request").kind).toBe("duplicate");
  });

  it("has its own line for every other row of the table", () => {
    for (const [status, error] of [[401, "unauthorized"], [403, "media_not_owned"],
      [413, "too_large"], [415, "unsupported_media"], [429, "rate_limited"],
      [404, "not_found"]] as const) {
      const out = mapCaptureError(status, error);
      if (out.kind !== "error") throw new Error(`expected an error outcome for ${status} ${error}`);
      expect(out.message).not.toBe("Capture did not answer. Try search.");
    }
  });

  it("falls back rather than echoing an error name it does not know", () => {
    expect(mapCaptureError(500, "kaboom")).toEqual({
      kind: "error", status: 500, message: "Capture did not answer. Try search.",
    });
  });
});

function sequence(steps: { status: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      headers: step.body === undefined ? undefined : { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const SIGNED = {
  path: "media/9f1c/clip.m4a",
  uploadUrl: "https://example.supabase.co/storage/v1/object/upload/signed/media/9f1c/clip.m4a",
  expiresInSeconds: 60 as const,
};

describe("captureMedia", () => {
  it("signs, PUTs the blob, then proposes with the returned path", async () => {
    const { fetchFn, calls } = sequence([
      { status: 200, body: SIGNED }, { status: 200 }, { status: 200, body: { ...DRAFT, method: "voice" } },
    ]);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const out = await captureMedia("voice", blob, { ...CTX, fetchFn });

    expect(out.kind).toBe("draft");
    expect(calls.map((c) => c.url)).toEqual([SIGN_URL, SIGNED.uploadUrl, PROPOSE_URL]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      kind: "audio", contentType: "audio/mp4", bytes: 3,
    });
    expect(calls[1].init.method).toBe("PUT");
    expect(calls[1].init.body).toBe(blob);
    expect((calls[1].init.headers as Record<string, string>)["content-type"]).toBe("audio/mp4");
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      method: "voice", localDate: "2026-09-11", tz: "America/New_York", slot: "meal-2",
      mediaPath: SIGNED.path,
    });
  });

  it("calls a label photo an image", async () => {
    const { fetchFn, calls } = sequence([
      { status: 200, body: SIGNED }, { status: 200 }, { status: 200, body: { ...DRAFT, method: "label" } },
    ]);
    await captureMedia("label", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn });
    expect(JSON.parse(String(calls[0].init.body)).kind).toBe("image");
  });

  it("stops at a refused signature and never uploads", async () => {
    const { fetchFn, calls } = sequence([{ status: 415, body: { error: "unsupported_media", message: "no" } }]);
    const out = await captureMedia("photo", new Blob(["x"], { type: "image/heic" }), { ...CTX, fetchFn });
    expect(out).toMatchObject({ kind: "error", status: 415 });
    expect(calls).toHaveLength(1);
  });

  it("stops at a failed upload and never proposes", async () => {
    const { fetchFn, calls } = sequence([{ status: 200, body: SIGNED }, { status: 403 }]);
    const out = await captureMedia("photo", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn });
    expect(out).toMatchObject({ kind: "error", status: 403, message: "The upload did not finish. Try again." });
    expect(calls).toHaveLength(2);
  });
});

const REF_A = "11111111-1111-4111-8111-111111111111";
const REF_B = "22222222-2222-4222-8222-222222222222";

function twoItemDraft(): ProposeResponse {
  return {
    ...DRAFT, method: "photo",
    items: [
      DRAFT.items[0],
      { seq: 2, label: "White rice", foodRefId: null, catalogFoodRevisionId: null,
        grams: 180, qty: 1, unit: "portion", portionId: null, confidence: 0.41,
        policy: { verdict: "unverified" }, autoResolved: false,
        alternatives: [{ foodRefId: REF_B, label: "Rice, white, long-grain, cooked", score: 0.72 }] },
    ],
  };
}

describe("draft edits", () => {
  it("marks an item edited only once its grams move", () => {
    const [first] = applyEdits(DRAFT.items, {});
    expect(first.wasEdited).toBe(false);
    const [edited] = applyEdits(DRAFT.items, { 1: { grams: 120 } });
    expect(edited).toMatchObject({ grams: 120, qty: 120, unit: "g", portionId: null, wasEdited: true });
  });

  it("keeps a picked portion's qty and id", () => {
    const [item] = applyEdits(DRAFT.items, { 1: { grams: 50, qty: 1, unit: "portion", portionId: 3 } });
    expect(item).toMatchObject({ grams: 50, qty: 1, unit: "portion", portionId: 3, wasEdited: true });
  });

  // The sheet merges each patch into the one before it, so a grams nudge that follows a portion
  // pick has to clear the portion by name. `null` is the clear; leaving the key out keeps the
  // portion, which is what let the pill and the gram count disagree.
  it("clears a picked portion when the next patch nulls it", () => {
    const picked = { grams: 50, qty: 1, unit: "portion", portionId: 3 };
    const [kept] = applyEdits(DRAFT.items, { 1: { ...picked, grams: 120 } });
    expect(kept).toMatchObject({ grams: 120, qty: 1, unit: "portion", portionId: 3 });

    const nudged = { grams: 120, qty: 120, unit: "g", portionId: null };
    const [cleared] = applyEdits(DRAFT.items, { 1: { ...picked, ...nudged } });
    expect(cleared).toMatchObject({ grams: 120, qty: 120, unit: "g", portionId: null });
  });

  it("drops the verdict and the revision when she swaps to an alternative", () => {
    const items = applyEdits(twoItemDraft().items, { 2: { foodRefId: REF_B, label: "Rice, white" } });
    expect(items[1]).toMatchObject({
      foodRefId: REF_B, label: "Rice, white", catalogFoodRevisionId: null, wasEdited: true,
      policy: { verdict: "unverified" },
    });
  });

  it("takes the chosen alternative's own search verdict on a swap (W139)", () => {
    const draft = twoItemDraft();
    draft.items[1].alternatives = [{ foodRefId: REF_B, label: "Rice, white, long-grain, cooked", score: 0.72,
      policy: { verdict: "blocked", reason: "avoid_list" } }];
    const items = applyEdits(draft.items, { 2: { foodRefId: REF_B, label: "Rice, white" } });
    expect(items[1].policy).toEqual({ verdict: "blocked", reason: "avoid_list" });
  });

  it("keeps the selected source revision but clears the old source's portion", () => {
    const items = applyEdits(DRAFT.items, { 1: {
      foodRefId: REF_B, catalogFoodRevisionId: 80, label: "Banana, raw",
    } });
    expect(items[0]).toMatchObject({ foodRefId: REF_B, catalogFoodRevisionId: 80,
      qty: 100, unit: "g", portionId: null, policy: { verdict: "unverified" }, wasEdited: true });
  });

  it("will not save while an ungrounded item is still in the list", () => {
    expect(canSave(applyEdits(twoItemDraft().items, {}))).toBe(false);
    expect(canSave(applyEdits(twoItemDraft().items, { 2: { removed: true } }))).toBe(true);
  });

  // A034 (ruling 2026-09-14): logging marks, never refuses — a blocked item saves with its mark.
  it("saves a blocked item, and needs something left to save", () => {
    const blocked: ProposeResponse = { ...DRAFT, items: [
      { ...DRAFT.items[0], policy: { verdict: "blocked", reason: "allergen:gluten" } }] };
    expect(canSave(applyEdits(blocked.items, {}))).toBe(true);
    expect(canSave(applyEdits(blocked.items, { 1: { removed: true } }))).toBe(false); // nothing left
  });
});

describe("commitDraft", () => {
  it("returns the server's nutrition_unchecked to the capture sheet, and nothing when absent", async () => {
    const answer = (extra: Record<string, unknown>) => (async () => new Response(JSON.stringify({
      status: "ok", entry_id: "e", rev: 1, items: [],
      totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 }, ...extra }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const at = { eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2" as const };
    const unchecked = await commitDraft(DRAFT, {}, { ...at, fetchImpl: answer({ nutrition_unchecked: true }) });
    expect(commitNutritionUnchecked(unchecked)).toBe(true);
    const checked = await commitDraft(DRAFT, {}, { ...at, fetchImpl: answer({}) });
    expect(commitNutritionUnchecked(checked)).toBe(false);
  });

  it("commits the chosen alternative's ref and revision together", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
        totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await commitDraft(DRAFT, { 1: { foodRefId: REF_B, catalogFoodRevisionId: 80,
      label: "Banana, raw" } }, { eatenAt: new Date("2026-09-11T18:30:00.000Z"),
      tz: "UTC", slot: "meal-2", fetchImpl });
    expect(sent).toMatchObject({ items: [{ food_ref_id: REF_B, food_revision_id: 80,
      qty: 100, unit: "g", portion_id: null }] });
  });

  it("sends a valid LogCommitRequest carrying the method and the draft id", async () => {
    let sent: unknown = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
        totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const draft = twoItemDraft();
    const out = await commitDraft(draft, { 1: { grams: 120 }, 2: { removed: true } }, {
      eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2", fetchImpl,
    });

    expect(out).toMatchObject({ status: "ok" });
    const parsed = logCommitRequestSchema.safeParse(sent);
    expect(parsed.success).toBe(true);
    expect(sent).toMatchObject({
      method: "photo", draft_id: draft.draftId, tz: "UTC", slot: "meal-2",
      items: [{ seq: 1, food_ref_id: REF_A, grams: 120, qty: 120, unit: "g",
                food_revision_id: 910, was_edited: true }],
    });
  });

  it("sets save_label_as_food only for the label method", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ status: "ok", entry_id: "e", rev: 1, items: [],
        totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const ctx = { eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2" as const,
      saveLabelAsFood: true, fetchImpl };

    const labelFood = { name: "Crackers", per100g: {}, allergenTags: [] };
    await commitDraft({ ...DRAFT, method: "label", labelFood }, {}, ctx);
    await commitDraft({ ...DRAFT, method: "photo", labelFood }, {}, ctx);
    expect(bodies[0].save_label_as_food).toBe(true);
    expect(bodies[1].save_label_as_food).toBeUndefined();
  });

  it("refuses to commit an empty list without a network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await commitDraft(DRAFT, { 1: { removed: true } }, {
      tz: "UTC", slot: "meal-2", fetchImpl,
    });
    expect(out).toMatchObject({ status: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // A034: a blocked item is sent, and the server's answer marks it (ruling 2026-09-14).
  it("sends a blocked item, so the server can record it with its mark", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ok", entry_id: "e",
      rev: 1, items: [], totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 },
      flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }] }),
    { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const blocked: ProposeResponse = { ...DRAFT, items: [
      { ...DRAFT.items[0], policy: { verdict: "blocked", reason: "allergen:gluten" } }] };
    const out = await commitDraft(blocked, {}, { tz: "UTC", slot: "meal-2", fetchImpl });
    expect(out).toMatchObject({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
