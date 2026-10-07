/**
 * Spec 3.5 (Phase 9 slice 3), media and capture routes: each route runs for real with user A's
 * session while user B holds a canary media object, canary AI usage and a canary food. The model
 * adapter is stubbed (no provider call) and records each call's user, so a case can prove the
 * model was never reached with B's media. Each case has a B-side control that shows the same call
 * passes the ownership check for B, and every row B owns is compared by value before and after.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { pointRequestClientAtBranch, sessionCookieFor } from "../log/fixtures";
import { syntheticJpeg } from "../helpers/synthetic-images";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

/** Users the stubbed model was called for, and what it was given, in call order. */
const modelCalls: { userId: string; purpose: string; text: string }[] = [];
vi.mock("@/lib/ai/adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/adapter")>()),
  generateStructured: vi.fn(async ({ userId, payload }: { userId: string;
    payload: { purpose: string; parts: readonly { text?: string }[] } }) => {
    const req = { userId, purpose: payload.purpose };
    modelCalls.push({ userId, purpose: payload.purpose,
      text: payload.parts.map((p) => p.text ?? "").join("\n") });
    if (req.purpose === "coach-transcribe") return { text: "two eggs" };
    if (/ToItems$/.test(req.purpose)) {
      return { items: [{ label: "rice", grams: 100, qty: 1, unit: "g", confidence: 0.9 }],
        notes: [] };
    }
    return { kind: "final", text: "Noted.", suggestions: [] };
  }),
}));

vi.mock("@/lib/ai/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/openrouter")>()),
  // Purpose-aware: with the OpenRouter env below, text/photo/label capture asks OpenRouter first
  // (lib/ai/capture.ts), so each purpose gets the shape its real schema expects. A capture twin is
  // recorded under its Gemini purpose ("photoToItems-openrouter" → "photoToItems"), so the
  // `/ToItems$/` checks below see a capture call whichever provider answered it.
  generateOpenRouter: vi.fn(async ({ userId, payload }: { userId: string;
    payload: { purpose: string; text: string } }) => {
    const purpose = payload.purpose.replace(/-openrouter$/, "");
    modelCalls.push({ userId, purpose, text: payload.text });
    if (purpose === "photoToIdeas") return { kind: "ingredients", title: null, ingredients: ["rice"] };
    if (purpose === "documentToPlan") return { kind: "other", title: null, days: [], ingredients: [], menu: [] };
    if (/ToItems$/.test(purpose)) {
      return { items: [{ label: "rice", grams: 100, qty: 1, unit: "g", confidence: 0.9 }],
        notes: [] };
    }
    if (purpose === "labelToNutrients") {
      const { NUTRIENT_CODES } = await import("@/lib/nutrients/codes");
      return { labelReadable: true, name: "Rice", servingGrams: 100,
        per100g: Object.fromEntries(NUTRIENT_CODES.map((code) => [code, null])) };
    }
    throw new Error(`admin-media mock: no OpenRouter shape for ${payload.purpose}`);
  }),
}));
vi.stubEnv("OPENROUTER_API_KEY", "test-key");
vi.stubEnv("OPENROUTER_ATTESTED", "1");

const { POST: signPOST } = await import("@/app/api/media/sign/route");
const { POST: transcribePOST } = await import("@/app/api/coach/transcribe/route");
const { POST: proposePOST } = await import("@/app/api/log/propose/route");
const { POST: coachPOST } = await import("@/app/api/coach/route");
const { POST: inspirePOST } = await import("@/app/api/plan/inspire/route");
const { POST: documentPOST } = await import("@/app/api/plan/document/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const CANARY = `canary-${crypto.randomUUID()}`;
const B_AI_CALLS = 3;
// W12-F: /api/plan/inspire now strips metadata server-side before any provider call
// (lib/media/strip-metadata.ts), so B's own "control" read needs a fully well-formed JPEG, not a
// signature-only stub.
const JPEG: Uint8Array<ArrayBuffer> = new Uint8Array(syntheticJpeg());

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await adminClient().from(table).insert(row);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

function req(url: string, cookie: string, body: unknown): Request {
  return new Request(`https://app.test${url}`, { method: "POST",
    headers: { "content-type": "application/json", cookie, "x-forwarded-for": "10.0.0.3",
      ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify(body) });
}

/** A media object of `owner`'s, uploaded and recorded as the upload route would. */
async function mediaOf(owner: string, ext: "jpg" | "m4a"): Promise<string> {
  const key = `${owner}/${crypto.randomUUID()}.${ext}`;
  const contentType = ext === "jpg" ? "image/jpeg" : "audio/mp4";
  const up = await adminClient().storage.from("media")
    .upload(key, new Blob([JPEG], { type: contentType }), { contentType });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  await insert("media_objects", { path: `media/${key}`, user_id: owner,
    kind: ext === "jpg" ? "image" : "audio", bytes: JPEG.length });
  return `media/${key}`;
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("media and capture routes answer only for their caller",
  () => {
    let a: TestUser;
    let b: TestUser;
    let aCookie = "";
    let bCookie = "";
    let bPhoto = "";
    let bAudio = "";

    beforeAll(async () => {
      assertLocalTargets();
      pointRequestClientAtBranch();
      [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
      await purge([a.id, b.id]);
      const clients: SupabaseClient[] = await Promise.all([userClient(a), userClient(b)]);
      [aCookie, bCookie] = await Promise.all(clients.map((c) => sessionCookieFor(c)));
      [bPhoto, bAudio] = await Promise.all([mediaOf(b.id, "jpg"), mediaOf(b.id, "m4a")]);
      for (let i = 0; i < B_AI_CALLS; i += 1) {
        await insert("ai_calls", { user_id: b.id, purpose: "textToItems", provider: "test",
          model_id: CANARY, sdk_version: "1", status: "ok" });
      }
    });

    beforeEach(() => {
      modelCalls.length = 0;
      resetRateLimits();
      vi.stubEnv("COACH_ENABLED", "1");
      vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo");
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await purge([a.id, b.id]);
    });

    it("media sign: A's upload is recorded under A's folder and user id only", async () => {
      const before = accountSnapshot(b.id);
      const res = await signPOST(req("/api/media/sign", aCookie,
        { kind: "image", contentType: "image/jpeg", bytes: 1000 }));
      expect(res.status).toBe(200);
      const { path } = await res.json() as { path: string };
      expect(path.startsWith(`media/${a.id}/`)).toBe(true);
      const row = await adminClient().from("media_objects").select("user_id")
        .eq("path", path).single();
      expect(row.error).toBeNull();
      expect(row.data?.user_id).toBe(a.id);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("transcribe: A cannot transcribe B's audio; the model is never called for it", async () => {
      const forB = await transcribePOST(req("/api/coach/transcribe", bCookie, { path: bAudio }));
      expect(forB.status).not.toBe(403);   // control: B passes the ownership check
      modelCalls.length = 0;
      const before = accountSnapshot(b.id);
      const forA = await transcribePOST(req("/api/coach/transcribe", aCookie, { path: bAudio }));
      expect(forA.status).toBe(403);
      expect(await forA.text()).not.toContain(CANARY);
      expect(modelCalls).toEqual([]);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("log propose: A cannot propose from B's photo, and B's AI usage never counts for A",
      async () => {
        const body = (extra: Record<string, unknown>) => ({ localDate: "2020-06-06", tz: "UTC",
          ...extra });
        const forB = await proposePOST(req("/api/log/propose", bCookie,
          body({ method: "text", text: "rice" })));
        expect(forB.status).toBe(200);
        expect((await forB.json() as { spend: { usedToday: number } }).spend.usedToday)
          .toBeGreaterThanOrEqual(B_AI_CALLS);

        const before = accountSnapshot(b.id);
        modelCalls.length = 0;
        const stolen = await proposePOST(req("/api/log/propose", aCookie,
          body({ method: "photo", mediaPath: bPhoto })));
        expect(stolen.status).toBe(403);
        expect(modelCalls).toEqual([]);

        const own = await proposePOST(req("/api/log/propose", aCookie,
          body({ method: "text", text: "rice" })));
        expect(own.status).toBe(200);
        const ownBody = await own.text();
        expect(ownBody).not.toContain(CANARY);
        expect((JSON.parse(ownBody) as { spend: { usedToday: number } }).spend.usedToday)
          .toBe(0);
        expect(modelCalls.map((c) => c.userId)).toEqual([a.id]);
        expect(accountSnapshot(b.id)).toEqual(before);
      });

    it("plan inspire: A cannot read B's photo; the model is never called for it", async () => {
      const forB = await inspirePOST(req("/api/plan/inspire", bCookie,
        { kind: "photo", mediaPath: bPhoto, localDate: "2020-06-06" }));
      expect(forB.status).toBe(200);   // control: B passes the ownership check
      modelCalls.length = 0;
      const before = accountSnapshot(b.id);
      const forA = await inspirePOST(req("/api/plan/inspire", aCookie,
        { kind: "photo", mediaPath: bPhoto, localDate: "2020-06-06" }));
      expect(forA.status).toBe(403);
      expect(await forA.text()).not.toContain(CANARY);
      expect(modelCalls).toEqual([]);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("plan document: A cannot read B's photo as a document; the model is never called for it", async () => {
      const body = { kind: "image", mediaPath: bPhoto, localDate: "2020-06-06", slot: "meal-2", slotTime: "12:30" };
      const forB = await documentPOST(req("/api/plan/document", bCookie, body));
      expect(forB.status).toBe(200);   // control: B passes the ownership check
      modelCalls.length = 0;
      const before = accountSnapshot(b.id);
      const forA = await documentPOST(req("/api/plan/document", aCookie, body));
      expect(forA.status).toBe(403);
      expect(await forA.text()).not.toContain(CANARY);
      expect(modelCalls).toEqual([]);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("coach attachment: A cannot attach B's photo to her turn", async () => {
      const before = accountSnapshot(b.id);
      modelCalls.length = 0;
      const res = await coachPOST(req("/api/coach", aCookie, { threadId: null,
        messageId: crypto.randomUUID(), text: "log this",
        attachment: { kind: "capture", v: 1, method: "photo", mediaPath: bPhoto,
          localDate: "2020-06-06" } }));
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(CANARY);
      expect(modelCalls.filter((c) => c.userId === a.id && /ToItems$/.test(c.purpose)))
        .toEqual([]);
      expect(accountSnapshot(b.id)).toEqual(before);
    });
  });
