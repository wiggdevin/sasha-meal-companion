/**
 * Phase 18 W6, `POST /api/foods/signals` (docs/specs/phase-18-open-world-foods.md §7.1, §W6):
 * 202 whatever the insert does, an unoffered food never reaches the store, zod refuses any other
 * shape (bounded slate and batch, no extra fields, so no free text or PII), a failed insert is
 * logged by error code only, and the per-account limit holds. The store runs on the local stack in
 * tests/migrations/food-signal-events-db.test.ts. Since W070 the store writes with the admin
 * client and the session's user id; the owner check still reads with the session client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { SIGNAL_RANKING_VERSIONS, SWAP_SHEET_RANKING_VERSION } from "@/lib/foods/signals";
import { RANKING_VERSION } from "@/lib/meals/snapshot";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { rpc, sessionRpc } = vi.hoisted(() => ({ rpc: vi.fn(), sessionRpc: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc }) }));

const { requireUser } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/foods/signals/route");

const USER = "6f1d0c1e-4a52-4c39-9a8e-3b2c1d0e9f11";
const OWN = "food:6f1d0c1e-4a52-4c39-9a8e-3b2c1d0e9f12";
/** Another account's food: present in user_foods, but not under USER. */
const THEIRS = "food:7a2e1d2f-5b63-4d4a-8b9f-4c3d2e1f0a22";
const MISSING = "food:8b3f2e3a-6c74-4e5b-9cae-5d4e3f2a1b33";
const ROWS = [{ id: OWN.slice(5), user_id: USER }, { id: THEIRS.slice(5), user_id: "someone-else" }];

/** user_foods reads: `.select("id").eq("user_id", u).in("id", ids)`, recorded for assertions. */
const foodReads: { table: string; filters: [string, unknown][] }[] = [];
let foodReadError: { code: string } | null = null;
function from(table: string) {
  const read = { table, filters: [] as [string, unknown][] };
  foodReads.push(read);
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => { read.filters.push([col, val]); return chain; },
    in: (col: string, ids: string[]) => {
      read.filters.push([col, ids]);
      const userId = read.filters.find(([c]) => c === "user_id")?.[1];
      const data = ROWS.filter((r) => r.user_id === userId && ids.includes(r.id)).map((r) => ({ id: r.id }));
      return Promise.resolve(foodReadError ? { data: null, error: foodReadError } : { data, error: null });
    },
  };
  return chain;
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientEventId: crypto.randomUUID(), slateId: crypto.randomUUID(), at: new Date().toISOString(),
    localDate: new Date().toISOString().slice(0, 10), surface: "swap_sheet", kind: "picked",
    occasion: "lunch", chosenKey: "food:smoked-salmon", offeredKeys: ["food:smoked-salmon", "catalog:42"],
    rankingVersion: "o2.1", ...over,
  };
}

function post(body: unknown, raw?: string): Request {
  return new Request("https://app.test/api/foods/signals", {
    method: "POST", headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
  rpc.mockReset();
  sessionRpc.mockReset();
  rpc.mockResolvedValue({ data: [{ inserted: 1, duplicates: 0, rejected: 0 }], error: null });
  foodReads.length = 0;
  foodReadError = null;
  vi.mocked(requireUser).mockResolvedValue({ userId: USER, client: { rpc: sessionRpc, from } as never });
});

afterEach(() => { vi.restoreAllMocks(); });

describe("POST /api/foods/signals", () => {
  it("answers 202 and hands the events to record_food_signals_for as rows, under the session user", async () => {
    const sent = event({ kind: "not_this", surface: "plan_sheet", chosenKey: "catalog:42" });
    const res = await POST(post({ events: [sent] }));
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(sessionRpc).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("record_food_signals_for", { p_user_id: USER, p_events: [{
      client_event_id: sent.clientEventId, slate_id: sent.slateId, at: sent.at, local_date: sent.localDate,
      surface: "plan_sheet", kind: "not_this", occasion: "lunch", chosen_key: "catalog:42",
      offered_keys: ["food:smoked-salmon", "catalog:42"], ranking_version: "o2.1",
    }] });
  });

  it("rejects an event for a food that was not offered: it never reaches the store", async () => {
    const offered = event();
    const res = await POST(post({ events: [event({ kind: "not_this", chosenKey: "food:beef-liver-pan-fried" }), offered] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 1 });
    const rows = rpc.mock.calls[0][1].p_events as { chosen_key: string }[];
    expect(rows.map((r) => r.chosen_key)).toEqual(["food:smoked-salmon"]);
  });

  it("rejects a key or ranking version the app never issued: identifiers, never free text", async () => {
    const own = OWN;
    const res = await POST(post({ events: [
      event({ chosenKey: "food:my-hiv-diagnosis", offeredKeys: ["food:my-hiv-diagnosis"] }),
      event({ offeredKeys: ["food:smoked-salmon", "food:stomach-pain-after"] }),
      event({ rankingVersion: "has-hiv" }),
      event({ chosenKey: own, offeredKeys: [own, "catalog:42"] }),
    ] }));
    expect(await res.json()).toEqual({ accepted: 1, rejected: 3 });
    const rows = rpc.mock.calls[0][1].p_events as { chosen_key: string }[];
    expect(rows.map((r) => r.chosen_key)).toEqual([own]);
  });

  it("accepts the ranking version the app issues now (append on a bump, never replace)", () => {
    expect(SIGNAL_RANKING_VERSIONS).toContain(RANKING_VERSION);
    expect(SIGNAL_RANKING_VERSIONS).toContain("o2.1");
    // The composed-meal surfaces (Plan sheet, suggestion cards) send their own ordering names.
    expect(SIGNAL_RANKING_VERSIONS).toEqual(expect.arrayContaining(["plan-sheet-v1", "suggestion-card-v1"]));
    // The swap sheet puts saved recipes and meals ahead of ranked plates: not pure o2.1.
    expect(SWAP_SHEET_RANKING_VERSION).toBe("swap-sheet-v1");
    expect(SIGNAL_RANKING_VERSIONS).toContain(SWAP_SHEET_RANKING_VERSION);
  });

  it("stores a swap-sheet event that names swap-sheet-v1", async () => {
    const res = await POST(post({ events: [event({ rankingVersion: SWAP_SHEET_RANKING_VERSION })] }));
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(rpc.mock.calls[0][1].p_events[0].ranking_version).toBe("swap-sheet-v1");
  });

  it("refuses a food:<uuid> key that is not the caller's own food, another account's and a missing one alike", async () => {
    const res = await POST(post({ events: [
      event({ chosenKey: OWN, offeredKeys: [OWN, "food:smoked-salmon"] }),
      event({ chosenKey: THEIRS, offeredKeys: [THEIRS, OWN] }),
      event({ chosenKey: OWN, offeredKeys: [OWN, MISSING] }),
      event({ chosenKey: OWN.toUpperCase().replace("FOOD:", "food:"), offeredKeys: [OWN.toUpperCase().replace("FOOD:", "food:")] }),
    ] }));
    expect(await res.json()).toEqual({ accepted: 2, rejected: 2 });
    const rows = rpc.mock.calls[0][1].p_events as { offered_keys: string[] }[];
    expect(rows.map((r) => r.offered_keys[0])).toEqual([OWN, OWN.toUpperCase().replace("FOOD:", "food:")]);
    // One owner-scoped read for the whole batch, every uuid at once.
    expect(foodReads).toHaveLength(1);
    expect(foodReads[0].table).toBe("user_foods");
    expect(foodReads[0].filters[0]).toEqual(["user_id", USER]);
    expect(new Set(foodReads[0].filters[1][1] as string[])).toEqual(new Set([OWN, THEIRS, MISSING].map((k) => k.slice(5))));
  });

  it("checks the largest batch (20 events of 8 distinct account foods) in one read", async () => {
    const hex = (n: number) => n.toString(16).padStart(12, "0");
    const events = Array.from({ length: 20 }, (_, e) => {
      const keys = Array.from({ length: 8 }, (_, k) => `food:00000000-0000-4000-8000-${hex(e * 8 + k)}`);
      return event({ chosenKey: keys[0], offeredKeys: keys });
    });
    expect(await (await POST(post({ events }))).json()).toEqual({ accepted: 0, rejected: 20 });
    expect(foodReads).toHaveLength(1);
    expect((foodReads[0].filters[1][1] as string[]).length).toBe(160);
  });

  it("reads nothing when the batch names no account food, and skips events already refused", async () => {
    await POST(post({ events: [event(), event({ chosenKey: OWN, offeredKeys: [OWN], rankingVersion: "nope" })] }));
    expect(foodReads).toHaveLength(0);
  });

  it("a failed owner read refuses the account-food events only, still 202, logging the code only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    foodReadError = { code: "57014" };
    const res = await POST(post({ events: [event({ chosenKey: OWN, offeredKeys: [OWN] }), event()] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 1 });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("57014");
    expect(logged).not.toMatch(/food:|6f1d0c1e/);
  });

  it("rejects a clock far ahead or behind, and a local date far from the event", async () => {
    const day = 24 * 60 * 60 * 1000;
    const res = await POST(post({ events: [
      event({ at: new Date(Date.now() + 11 * 60 * 1000).toISOString() }),
      event({ at: new Date(Date.now() - 15 * day).toISOString() }),
      event({ localDate: new Date(Date.now() - 3 * day).toISOString().slice(0, 10) }),
    ] }));
    expect(await res.json()).toEqual({ accepted: 0, rejected: 3 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed insert still answers 202 and logs only its code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement food:smoked-salmon" } });
    const failed = await POST(post({ events: [event()] }));
    expect(failed.status).toBe(202);
    expect(await failed.json()).toEqual({ accepted: 1, rejected: 0 });
    rpc.mockRejectedValue(new Error("fetch failed for food:smoked-salmon"));
    expect((await POST(post({ events: [event()] }))).status).toBe(202);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("57014");
    expect(logged).not.toMatch(/food:|catalog:|salmon/);
    expect(logged).not.toContain(USER);
  });

  it("refuses anything but the contract: 400 with nothing stored", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `catalog:${i + 1}`);
    const bodies: unknown[] = [
      {}, { events: [] }, { events: Array.from({ length: 21 }, () => event()) },
      { events: [event({ kind: "dislike" })] }, { events: [event({ surface: "coach" })] },
      { events: [event({ offeredKeys: nine, chosenKey: "catalog:1" })] },
      { events: [event({ offeredKeys: ["food:smoked-salmon", "food:smoked-salmon"] })] },
      { events: [event({ chosenKey: "Salmon fillet", offeredKeys: ["Salmon fillet"] })] },
      { events: [event({ name: "Salmon fillet" })] }, { events: [event({ note: "hurt my stomach" })] },
      { events: [event()], userId: USER }, { events: [event({ clientEventId: "retry-1" })] },
      { events: [event({ occasion: "brunch" })] }, { events: [event({ localDate: "2026-02-30" })] },
    ];
    for (const body of bodies) {
      const res = await POST(post(body));
      expect([JSON.stringify(body).slice(0, 60), res.status]).toEqual([JSON.stringify(body).slice(0, 60), 400]);
    }
    expect((await POST(post(null, "not json"))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a body over 48 KB with 413", async () => {
    const res = await POST(post(null, JSON.stringify({ events: [event()], pad: "x".repeat(50 * 1024) })));
    expect(res.status).toBe(413);
  });

  it("limits each account to 60 batches a minute (fail closed, the shared limiter)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await POST(post({ events: [event()] }))).status);
    expect(statuses.slice(0, 60).every((s) => s === 202)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("answers 401 without a session, before reading the body", async () => {
    const { HttpError } = await import("@/lib/server/auth");
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    expect((await POST(post({ events: [event()] }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});
