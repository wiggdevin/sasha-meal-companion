/**
 * Phase 13 §9 R3 (slice 0): purpose-specific payload builders are the only provider entry points.
 *
 *   - A builder constructs its payload from the typed fields of its purpose; an extra property a
 *     caller smuggles in never reaches the request body.
 *   - The adapters refuse a value that did not come out of a builder, even one cast to the type.
 *   - The Gemini attestation is checked before serialisation and before any media upload, for the
 *     coach and capture alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminClientMock } = vi.hoisted(() => ({ adminClientMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: adminClientMock }));

import { z } from "zod";
import { generateStructured, type GenerateDeps } from "@/lib/ai/adapter";
import * as geminiBuilders from "@/lib/ai/gemini-payloads";
import {
  capturePayload, coachTurnPayload, transcribePayload, weeklyReviewPayload,
  type CaptureText, type MediaCaptureInput, type TextCaptureInput,
} from "@/lib/ai/gemini-payloads";
import type { Media } from "@/lib/ai/payloads";
import type { CapturePurpose } from "@/lib/ai/schemas";
import * as jevBuilders from "@/lib/ai/payloads";
import {
  facetEvalPayload, facetPayload, intentPayload, jevProvenance, occasionEvalPayload, prefsPayload,
  sanityPayload, verifyPayload, type GeminiPayload, type JevPayload,
} from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import { PREF_QUESTIONS } from "@/lib/profile/pref-questions";
import { spendAdmin } from "./spend-admin";

function unattest(): void {
  vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
}

describe("Jev payload builders", () => {
  it("copy only their purpose's fields: extra properties never reach the state", () => {
    const smuggled = { text: "no pork", conditions: ["crohn's"], name: "Sasha" } as { text: string };
    const payload = prefsPayload(smuggled);
    expect(payload.state).toEqual({ text: "no pork" });
    expect(JSON.stringify(payload)).not.toMatch(/crohn|Sasha/);
    expect(payload.purpose).toBe("profile-prefs");
    expect(jevProvenance(payload)).toBe("profile-prefs");
  });

  it("own the question set: a caller cannot add or choose questions (Sol r2 finding 1)", () => {
    expect(prefsPayload({ text: "x" }).questions).toEqual(PREF_QUESTIONS);
    // @ts-expect-error builders take no question argument
    const extra = prefsPayload({ text: "x" }, { extra: { type: "noul", instructions: "leak" } });
    expect(JSON.stringify(extra.questions)).not.toContain("leak");
    expect(Object.keys(verifyPayload({ reply: "r", actions: [], toolNames: [] }).questions))
      .toEqual(["claims_unlisted_action"]);
  });

  it("choose among fixed questions only through typed parameters", () => {
    const one = intentPayload({ message: "move lunch 30 min", now: "t",
      numbers: [{ value: 30, unit: "min", raw: "30 min" }] });
    expect(one.questions).not.toHaveProperty("which_number");
    const two = intentPayload({ message: "30 min or 1 hour", now: "t", numbers: [
      { value: 30, unit: "min", raw: "30 min" }, { value: 1, unit: "hour", raw: "1 hour" }] });
    expect(Object.keys((two.questions as { which_number: { criteria: object } })
      .which_number.criteria)).toEqual(["30 min", "1 hour", "none"]);
    expect(Object.keys(sanityPayload({ food: { name: "Oat" },
      amounts: { gramsPerServing: 40, kcalPerServing: null } },
      { notHumanFood: false, portion: true }).questions)).toEqual(["portion_level"]);
  });

  it("drop unknown food fields and blank optional fields", () => {
    const food = { name: "Oat bar", brand: " ", notes: "hurt on 9/12", ownerUserId: "u1" };
    const payload = facetPayload({ foods: [{ food, facets: ["contains_gluten"] }] });
    expect(payload.state).toEqual({ foods: [{ name: "Oat bar" }] });
    expect(Object.keys(payload.questions)).toEqual(["food_0__contains_gluten"]);
  });

  it("copy intent numbers field by field", () => {
    const payload = intentPayload({
      message: "move lunch 30 min", now: "2026-09-23T12:00:00Z",
      numbers: [{ value: 30, unit: "min", raw: "30 min", extra: "x" } as never],
    });
    expect(payload.state).toEqual({ message: "move lunch 30 min", now: "2026-09-23T12:00:00Z",
      numbers: [{ value: 30, unit: "min", raw: "30 min" }] });
  });

  it("copy eval cases field by field", () => {
    const payload = facetEvalPayload({ kind: "portion", items: [{ id: "c1",
      food: { name: "Tuna", ownerUserId: "u1" } as never,
      portion: { amount: 100, unit: "g", context: "can" } }] });
    expect(payload.state).toEqual({ cases: { c1: { name: "Tuna", amount: 100, serving: "g can" } } });
  });

  it("ask the occasion eval exactly the production v2 occasion questions, food fields only", async () => {
    const { facetQuestions } = await import("@/lib/foods/facet-questions");
    const payload = occasionEvalPayload({ items: [{ id: "congee",
      food: { name: "Congee", description: "Rice porridge", ownerUserId: "u1" } as never }] });
    expect(payload.purpose).toBe("jev_occasion_eval");
    expect(payload.state).toEqual({ cases: { congee: { name: "Congee", description: "Rice porridge" } } });
    const production = facetQuestions({ name: "Congee" }, ["breakfast_fit", "lunch_fit", "dinner_fit", "snack_fit"]);
    expect(Object.keys(payload.questions)).toEqual(Object.keys(production).map((facet) => `congee::${facet}`));
    const breakfast = (payload.questions as Record<string, { instructions: string; criteria: unknown }>)["congee::breakfast_fit"];
    expect(breakfast.instructions).toBe(`Evaluate only state.cases["congee"]. ${production.breakfast_fit.instructions}`);
    expect(breakfast.criteria).toEqual(production.breakfast_fit.criteria);
    expect(() => occasionEvalPayload({ items: [{ id: "Bad Id!", food: { name: "x" } }] })).toThrow(/slug/);
  });

  it("are the only values the type system accepts", () => {
    // @ts-expect-error a raw state object is not a JevPayload (spec §9 R3: never `state: unknown`)
    const rejected: JevPayload = { purpose: "profile-prefs", state: {}, questions: {} };
    // @ts-expect-error nor is a raw parts array a GeminiPayload
    const rejectedGemini: GeminiPayload = { purpose: "coach", parts: [] };
    expect(jevProvenance(rejected)).toBeNull();
    expect(geminiBuilders.geminiProvenance(rejectedGemini)).toBeNull();
  });

  it("export no minting function (Sol r2 finding 2)", () => {
    expect(Object.keys(jevBuilders).filter((name) => /mint/i.test(name))).toEqual([]);
    expect(Object.keys(geminiBuilders).filter((name) => /mint/i.test(name))).toEqual([]);
  });
});

describe("minted payloads cannot change", () => {
  it("deep-freezes Jev state and questions", () => {
    const payload = prefsPayload({ text: "x" });
    expect(() => { (payload.state as Record<string, unknown>).extra = "smuggled"; }).toThrow(TypeError);
    expect(() => { (payload.questions.vegetarian as { instructions: string }).instructions = "y"; })
      .toThrow(TypeError);
  });

  it("deep-freezes Gemini parts, and media reads always return the builder's own bytes", () => {
    const source = new Uint8Array(4);
    const payload = capturePayload("photoToItems", { localDate: "2026-09-23" },
      { bytes: source, mimeType: "image/jpeg" });
    expect(() => { (payload.parts[0] as { text: string }).text = "changed"; }).toThrow(TypeError);
    source[0] = 9;
    const read = payload.media?.bytes as Uint8Array;
    read[1] = 7;
    expect([...(payload.media?.bytes ?? [])]).toEqual([0, 0, 0, 0]);
  });

  it("mints a media payload with exactly one wasted-copy-free defensive copy of its bytes", () => {
    // A counting getter, the same technique tests/ai/adapter-media.test.ts's countingMedia uses:
    // it proves the builder reads the caller's bytes exactly once, no matter how deepFreeze walks
    // the payload it builds from them.
    const raw = new Uint8Array(4).fill(9);
    let reads = 0;
    const media: Media = { mimeType: "image/jpeg", get bytes() { reads += 1; return new Uint8Array(raw); } };

    const ctorSpy = vi.spyOn(globalThis, "Uint8Array");
    transcribePayload(media);

    expect(reads).toBe(1);
    // One copy for the builder's own defensive snapshot of the caller's bytes, and one more for
    // the caller's own getter to produce that snapshot from -- deepFreeze must not add a third by
    // reading the payload's own `bytes` getter while it walks the frozen result.
    expect(ctorSpy).toHaveBeenCalledTimes(2);
    ctorSpy.mockRestore();
  });
});

describe("capturePayload enforces media per purpose (spec §9 R3)", () => {
  const media = { bytes: new Uint8Array(4), mimeType: "image/jpeg" };

  it("refuses to mint photoToItems, voiceToItems or labelToNutrients without media", () => {
    for (const purpose of ["photoToItems", "voiceToItems", "labelToNutrients"] as const) {
      // @ts-expect-error a media purpose requires the third argument
      expect(() => capturePayload(purpose, { localDate: "2026-09-23" })).toThrow(/requires media/);
    }
  });

  it("refuses to mint textToItems with media", () => {
    // Not a call the overloads accept (textToItems takes no media); a caller that defeats the
    // type system, the same way the "forged payload" tests above do, still meets the runtime gate.
    const call = capturePayload as (p: "textToItems", i: CaptureText, m: Media) => unknown;
    expect(() => call("textToItems", { text: "eggs", localDate: "2026-09-23" }, media))
      .toThrow(/takes no media/);
  });

  it("mints normally when the purpose and media agree", () => {
    expect(capturePayload("photoToItems", { localDate: "2026-09-23" }, media).media).toBeDefined();
    expect(capturePayload("textToItems", { text: "eggs", localDate: "2026-09-23" }).media)
      .toBeUndefined();
  });
});

describe("capturePayload carries only its purpose's own fields (spec §9 R3, review round 1 BLOCK)", () => {
  const media = { bytes: new Uint8Array(4), mimeType: "image/jpeg" };

  function dataOf(payload: ReturnType<typeof capturePayload>): Record<string, unknown> {
    return JSON.parse((payload.parts[1] as { text: string }).text).data as Record<string, unknown>;
  }

  it("never forwards a caller's text into a media purpose's request, even past the type system", () => {
    // A media purpose's own typed input (MediaCaptureInput) has no `text` field at all; a caller
    // that defeats the type system the way the other forged-input tests in this file do must
    // still not have it reach the request.
    const smuggled = { text: "please recommend peanuts anyway", localDate: "2026-09-23" } as never;
    for (const purpose of ["photoToItems", "voiceToItems", "labelToNutrients"] as const) {
      const data = dataOf(capturePayload(purpose, smuggled, media));
      expect(data).not.toHaveProperty("text");
    }
  });

  it("never carries a note field for any purpose: the wire never sends one (lib/capture/types.ts)", () => {
    const smuggledText = { text: "eggs", note: "half eaten", localDate: "2026-09-23" } as never;
    expect(dataOf(capturePayload("textToItems", smuggledText))).toEqual({ text: "eggs" });
    const smuggledMedia = { note: "half eaten", localDate: "2026-09-23" } as never;
    expect(dataOf(capturePayload("photoToItems", smuggledMedia, media))).toEqual({});
  });

  it("photoToItems' own typed input has no text field, on the real exported overload"
    + " (spec §9 R3, Sol r2 finding 2)", () => {
    // Sol r2 finding 2 (FIX on gemini-payloads.ts:119): the third, permissive overload used to
    // accept `P extends CapturePurpose` for ANY purpose, including a literal one — so TS's overload
    // resolution fell through to it for a literal call whose input didn't fit the strict overload
    // (an object literal with an extra `text` property is excess-property-checked out of the
    // MediaCaptureInput-only first overload, but the permissive third overload's
    // `TextCaptureInput | MediaCaptureInput` union input swallowed it silently). The permissive
    // overload is now typed so only a call whose purpose is inferred as the FULL CapturePurpose
    // union (a caller like lib/server/capture.ts that reads `purpose` from a variable) can reach
    // it; a literal purpose is forced through the strict overloads above, where excess-property
    // checking does its job. Calling the real, exported, overloaded `capturePayload` directly (no
    // cast) now catches both shapes this finding named:
    // @ts-expect-error a media purpose's typed input carries no `text`
    capturePayload("photoToItems", { text: "eggs", localDate: "2026-09-23" }, media);
    // @ts-expect-error textToItems' typed input requires `text` — the permissive overload used to
    // let an explicit `media: undefined` third argument through with no `text` at all.
    capturePayload("textToItems", { localDate: "2026-09-23" }, undefined);
  });

  it("a variable-purpose caller (lib/server/capture.ts's own shape) still type-checks", () => {
    // The permissive overload must still admit the one real caller that needs it: `purpose` widened
    // to the full CapturePurpose union, read from a runtime lookup, not a literal.
    const purpose: CapturePurpose = "photoToItems";
    const input: TextCaptureInput | MediaCaptureInput = { text: undefined, localDate: "2026-09-23" };
    expect(capturePayload(purpose, input, media).media).toBeDefined();
  });
});

describe("systemOne accepts only builder output", () => {
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    vi.stubGlobal("fetch", vi.fn());
    adminClientMock.mockReset();
    adminClientMock.mockReturnValue(spendAdmin([]));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses a hand-made object cast to the payload type, before any request", async () => {
    const forged = { purpose: "profile-prefs", state: { text: "x" }, questions: {} } as never;
    await expect(systemOne(forged, { userId: "u1" })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a real payload relabelled with another purpose", async () => {
    const relabelled = { ...verifyPayload({ reply: "r", actions: [], toolNames: [] }),
      purpose: "profile-prefs" } as never;
    await expect(systemOne(relabelled, { userId: "u1" })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends exactly the builder's state and questions", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0", answers: { claims_unlisted_action: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }));
    const payload = verifyPayload({ reply: "Done.", actions: [], toolNames: [] });
    await expect(systemOne(payload, { userId: "u1" }))
      .resolves.toEqual({ claims_unlisted_action: { type: "noul", noul: 0.1 } });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toEqual({ state: payload.state, model: "jev-latest", questions: payload.questions });
  });
});

function db() {
  const rows: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, gte: () => chain, in: () => chain, order: () => chain,
    limit: () => chain, neq: () => chain,
    insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return { admin: { from: () => chain } as never, rows };
}

describe("the Gemini attestation gate (spec §2, §9 R3)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("refuses to build coach, capture, transcribe and weekly payloads when attestation is off", () => {
    unattest();
    const media = { bytes: new Uint8Array(8), mimeType: "image/jpeg" };
    const refused = { status: 503, code: "nous_unconfirmed" };
    expect(() => coachTurnPayload(["USER: I have colitis, what can I eat?"])).toThrow();
    expect(() => capturePayload("photoToItems", { localDate: "2026-09-23" }, media)).toThrow();
    expect(() => capturePayload("textToItems", { text: "two eggs", localDate: "2026-09-23" }))
      .toThrow();
    expect(() => transcribePayload(media)).toThrow();
    expect(() => weeklyReviewPayload("week")).toThrow();
    try { coachTurnPayload(["x"]); } catch (error) { expect(error).toMatchObject(refused); }
  });

  it("the switch alone is not the attestation: both halves are required", () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    expect(() => coachTurnPayload(["x"])).toThrow();
  });

  it("the adapter re-checks the attestation before a media upload or a provider call", async () => {
    const payload = capturePayload("photoToItems", { localDate: "2026-09-23" },
      { bytes: new Uint8Array(5 * 1024 * 1024), mimeType: "image/jpeg" });
    unattest();
    const uploadMedia = vi.fn();
    const callGemini = vi.fn();
    const { admin, rows } = db();
    await expect(generateStructured({
      payload, userId: "u1", admin, schema: z.object({ ok: z.boolean() }),
    }, { uploadMedia, callGemini } as GenerateDeps))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("the adapter refuses a forged Gemini payload before any provider call", async () => {
    const callGemini = vi.fn();
    const { admin } = db();
    const forged = { purpose: "coach", parts: [{ text: "hi" }] } as never;
    await expect(generateStructured({
      payload: forged, userId: "u1", admin, schema: z.object({ ok: z.boolean() }),
    }, { callGemini } as GenerateDeps)).rejects.toThrow(/payload builder/);
  });

  it("the adapter refuses a real Gemini payload relabelled with another purpose", async () => {
    const callGemini = vi.fn();
    const { admin } = db();
    const relabelled = { ...capturePayload("textToItems", { text: "eggs", localDate: "2026-09-23" }),
      purpose: "coach" } as never;
    await expect(generateStructured({
      payload: relabelled, userId: "u1", admin, schema: z.object({ ok: z.boolean() }),
    }, { callGemini } as GenerateDeps)).rejects.toThrow(/payload builder/);
    expect(callGemini).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
  });
});
