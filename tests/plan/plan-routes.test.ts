/**
 * POST /api/plan/document and /api/plan/inspire in front of their readers: no session is a 401
 * with no read, each user's burst cap answers 429, and an oversized body is a 413 before any read.
 * The readers are mocked (their own tests cover them); owned-media reads are covered against a
 * real database in tests/tenancy/admin-media.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { MAX_DOCUMENT_BODY } from "@/lib/plan/document-types";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ admin: true }) }));
vi.mock("@/lib/server/plan-document", () => ({ readDocument: vi.fn(async () => ({ kind: "other" })) }));
vi.mock("@/lib/server/plan-inspire", () => ({
  inspire: vi.fn(async () => ({ kind: "unknown", title: null, ingredients: [] })),
}));

const { requireUser } = await import("@/lib/server/auth");
const { readDocument } = await import("@/lib/server/plan-document");
const { inspire } = await import("@/lib/server/plan-inspire");
const { POST: documentPOST } = await import("@/app/api/plan/document/route");
const { POST: inspirePOST } = await import("@/app/api/plan/inspire/route");

const userClient = { user: true };
const post = (path: string, body: unknown, ip = "1.1.1.1") => new Request(`https://app.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
const docBody = { kind: "text", text: "Lunch: chicken 150 g", localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30" };
const photoBody = { kind: "photo", localDate: "2026-10-05",
  mediaPath: "media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg" };

beforeEach(() => {
  resetRateLimits();
  vi.mocked(readDocument).mockClear();
  vi.mocked(inspire).mockClear();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: userClient } as never);
});

describe("/api/plan/document", () => {
  it("refuses a request with no session before reading anything", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await documentPOST(post("/api/plan/document", docBody))).status).toBe(401);
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("reads as the signed-in user with the admin and user clients", async () => {
    expect((await documentPOST(post("/api/plan/document", docBody))).status).toBe(200);
    expect(vi.mocked(readDocument).mock.calls[0].slice(0, 3)).toEqual([{ admin: true }, userClient, "u1"]);
  });

  it("caps each user at 8 reads a minute, from any address", async () => {
    for (let i = 0; i < 8; i += 1) {
      expect((await documentPOST(post("/api/plan/document", docBody, `10.0.0.${i}`))).status).toBe(200);
    }
    expect((await documentPOST(post("/api/plan/document", docBody, "10.0.0.99"))).status).toBe(429);
    expect(readDocument).toHaveBeenCalledTimes(8);
  });

  it("never sends a read the phone's schema would refuse (re-audit r1 #5)", async () => {
    vi.mocked(readDocument).mockResolvedValueOnce({ kind: "menu", title: null, ingredients: [], menu: [
      { name: "Bowl", kcal: 500, protein: 30, carbs: 50, fat: 15, tip: null, check: "x".repeat(200) }] } as never);
    const res = await documentPOST(post("/api/plan/document", docBody));
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/Couldn.t read that file/);
  });

  it("refuses an oversized body with 413 before any read", async () => {
    const res = await documentPOST(post("/api/plan/document", { ...docBody, text: "x".repeat(MAX_DOCUMENT_BODY) }));
    expect(res.status).toBe(413);
    expect(readDocument).not.toHaveBeenCalled();
  });
});

describe("/api/plan/inspire", () => {
  it("refuses a request with no session before reading anything", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await inspirePOST(post("/api/plan/inspire", photoBody))).status).toBe(401);
    expect(inspire).not.toHaveBeenCalled();
  });

  it("passes the user's own client, so a menu is checked against their Avoid list", async () => {
    expect((await inspirePOST(post("/api/plan/inspire", photoBody))).status).toBe(200);
    expect(vi.mocked(inspire).mock.calls[0].slice(0, 3)).toEqual([{ admin: true }, userClient, "u1"]);
  });

  it("caps each user at 20 reads a minute and refuses a body over 4 KB", async () => {
    for (let i = 0; i < 20; i += 1) await inspirePOST(post("/api/plan/inspire", photoBody, `10.0.1.${i}`));
    expect((await inspirePOST(post("/api/plan/inspire", photoBody, "10.0.1.99"))).status).toBe(429);
    resetRateLimits();
    const big = await inspirePOST(post("/api/plan/inspire", { ...photoBody, pad: "x".repeat(4 * 1024) }));
    expect(big.status).toBe(413);
    expect(inspire).toHaveBeenCalledTimes(20);
  });
});
