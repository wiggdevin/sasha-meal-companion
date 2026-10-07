// @vitest-environment jsdom
/**
 * The phone's half of server-recorded coach Undo (audit 2026-10-04 P1 #6): an applied action
 * posts its token; Undo asks the server first, uses the local token only when the server certainly
 * did not and will not undo it, and marks the record undone before the Undo settles. Review t4
 * BLOCK 1 and 2: each race below once undid water twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import type { UndoToken } from "@/lib/coach/apply-client";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(), undo: vi.fn(), syncOnce: vi.fn(), flushOutboxNow: vi.fn(),
}));
vi.mock("@/lib/coach/actions/apply", () => ({
  applyBindingFor: () => ({ apply: mocks.apply, undo: mocks.undo }),
}));
vi.mock("@/lib/sync/client", () => ({
  syncOnce: mocks.syncOnce, flushOutboxNow: mocks.flushOutboxNow,
}));

const { bindAccount, unbindAccount } = await import("@/lib/device/account");
const { applyCoachAction, resetApplyState, undoCoachAction } = await import("@/lib/coach/apply-client");
const { UNDO_UNCONFIRMED_REASON } = await import("@/lib/coach/undo-client");

const USER = "aaaaaaaa-0000-4000-8000-00000000000a";
const RECORD = "3f1b1a2c-0000-4000-8000-0000000000d1";
const token = { kind: "log_water", date: "2026-10-05", cups: 2, after: 6 } as UndoToken;
const action = { kind: "log_water", actionId: "act-1", flagged: [], ml: 500 } as unknown as CoachAction;

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Handler = (body: Record<string, unknown> | undefined) => [number, unknown] | Promise<[number, unknown]> | "drop";

function server(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url: input, method, body });
    const handler = routes[`${method} ${input.split("?")[0]}`];
    const answer: [number, unknown] | "drop" = handler ? await handler(body)
      : [404, { error: "not_found", message: "none" }];
    if (answer === "drop") throw new TypeError("network connection lost");
    const [status, json] = answer;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
  const routesOf = () => calls.map((c) => `${c.method} ${c.url}`);
  return { calls, routesOf, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const view = (over: Record<string, unknown> = {}) => ({
  id: RECORD, actionId: "act-1", kind: "log_water", threadId: null, messageId: null,
  createdAt: "2026-10-05T12:00:00.000Z", expiresAt: "2026-10-12T12:00:00.000Z",
  undoneAt: null, expired: false, serverUndoable: true, ...over,
});
const UNDO = `POST /api/coach/undo/${RECORD}`;

beforeEach(() => {
  localStorage.clear();
  resetApplyState();
  bindAccount(USER);
  mocks.apply.mockReset().mockResolvedValue({ status: "applied", token });
  mocks.undo.mockReset().mockResolvedValue(undefined);
  mocks.syncOnce.mockReset().mockResolvedValue(undefined);
  mocks.flushOutboxNow.mockReset().mockResolvedValue(true);
});
afterEach(() => { unbindAccount(); });

describe("recording", () => {
  it("posts the applied token with the thread, and keeps the local token too", async () => {
    const api = server({ "POST /api/coach/undo": () => [200, { undo: view() }] });
    const result = await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl,
      threadId: "3f1b1a2c-0000-4000-8000-000000000001" });
    expect(result).toEqual({ status: "applied", token });
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toMatchObject({ method: "POST", url: "/api/coach/undo", body: {
      actionId: "act-1", kind: "log_water", token, threadId: "3f1b1a2c-0000-4000-8000-000000000001" } });
  });

  it("an Undo tapped while the record is in flight waits for it, then the server undoes once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const api = server({
      "POST /api/coach/undo": async () => { await held; return [200, { undo: view() }]; },
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [200, { undo: view({ undoneAt: "now" }), performed: "server" }],
    });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    const undone = undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    await Promise.resolve();
    expect(api.routesOf()).toEqual(["POST /api/coach/undo"]);
    release();
    await undone;
    expect(api.routesOf()).toEqual(["POST /api/coach/undo", "GET /api/coach/undo?actionId=act-1", UNDO]);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("offline: the record waits in the queue, the token undoes, and the record is sent already undone", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const offline = server({ "POST /api/coach/undo": () => "drop", "GET /api/coach/undo": () => "drop" });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: offline.fetchImpl });
    await undoCoachAction("act-1", token, { fetchImpl: offline.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
    onLine.mockRestore();

    const online = server({ "POST /api/coach/undo": () => [200, { undo: view({ undoneAt: "now" }) }] });
    const { flushPendingUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    await flushPendingUndos(accountHandle(), { fetchImpl: online.fetchImpl });
    // Only the undone record goes out: a late "applied" record can never re-open the action.
    expect(online.calls.map((c) => c.body?.undone)).toEqual([true]);
  });

  it("a record whose answer was lost is asked for fresh: undone elsewhere means the token is not used", async () => {
    let stored = false;
    const api = server({
      "POST /api/coach/undo": () => { stored = true; return "drop"; },
      "GET /api/coach/undo": () => [200, { next: null, undos: stored ? [view({ undoneAt: "elsewhere" })] : [] }],
    });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(api.routesOf()).toContain("GET /api/coach/undo?actionId=act-1");
  });

  it("a record whose request may have left (dropped answer), with the server unreadable, keeps the token", async () => {
    const api = server({ "POST /api/coach/undo": () => "drop", "GET /api/coach/undo": () => "drop" });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a record answered 5xx (maybe stored), with the server unreadable, keeps the token", async () => {
    const api = server({ "POST /api/coach/undo": () => [502, { error: "x", message: "x" }],
      "GET /api/coach/undo": () => "drop" });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("queued records are sent after every sync pass, not only on Undo", async () => {
    const { startAccountSync } = await import("@/lib/sync/account-sync");
    const { accountHandle } = await import("@/lib/device/account");
    const flushUndos = vi.fn(async () => undefined);
    const stop = startAccountSync(accountHandle(), { run: async () => undefined, win: window, flushUndos });
    await vi.waitFor(() => expect(flushUndos).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(flushUndos).toHaveBeenCalledTimes(2));
    stop();
  });
});

describe("undoCoachAction", () => {
  it("undoes on the server with no local token (a second device), then syncs", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [200, { undo: view({ undoneAt: "now" }), performed: "server" }],
    });
    const outcome = await undoCoachAction("act-1", null, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(api.routesOf()).toEqual(["GET /api/coach/undo?actionId=act-1", UNDO]);
    await vi.waitFor(() => expect(mocks.syncOnce).toHaveBeenCalledTimes(1));
    // This tap just did it, fresh (t23 #8): no "already" flag.
    expect(outcome).toBeUndefined();
  });

  it("prefers the server record over the local token, flushing queued writes first", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [200, { undo: view({ undoneAt: "now" }), performed: "server" }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.flushOutboxNow).toHaveBeenCalledTimes(1);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("treats a record already undone elsewhere as done and refreshes the projection", async () => {
    const api = server({ "GET /api/coach/undo": () => [200, { next: null, undos: [view({ undoneAt: "x" })] }] });
    const outcome = await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.syncOnce).toHaveBeenCalledTimes(1));
    // Found undone before this tap tried anything (t23 #8): "already", not freshly undone now.
    expect(outcome).toEqual({ already: true });
  });

  it("a second tap that loses the race to the server's own answer reports already undone (t23 #8)", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [409, { error: "undo_already_undone", message: "This was already undone." }],
    });
    const outcome = await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(outcome).toEqual({ already: true });
  });

  it("not synced: the token undoes, and the record is marked undone before the Undo settles", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ kind: "skip_slot" })] }],
      [UNDO]: () => [409, { error: "undo_not_synced", message: "not yet" }],
      "POST /api/coach/undo": () => [200, { undo: view({ undoneAt: "now" }) }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
    expect(api.calls.at(-1)).toMatchObject({ url: "/api/coach/undo",
      body: { actionId: "act-1", kind: "log_water", token, undone: true } });
  });

  it("undoes a phone-only kind locally and marks the server record", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ kind: "skip_slot", serverUndoable: false })] }],
      "POST /api/coach/undo": () => [200, { undo: view({ undoneAt: "now" }) }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
    expect(api.calls.at(-1)?.body).toMatchObject({ undone: true });
  });

  it("surfaces a server conflict and never runs the local undo over the later change", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [409, { error: "undo_conflict", message: "Water has changed since, so Undo left it alone." }],
    });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("Water has changed since");
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it.each([
    ["undo_receipt_mismatch", 409, "That no longer matches what the coach changed, so Undo left it alone."],
    ["undo_receipt_record", 409, "This was recorded by the server. Undo it from the list."],
    ["undo_receipt_inconsistent", 422, "This change can only be undone on the phone that made it."],
    ["undo_source_mismatch", 422, "This change can only be undone on the phone that made it."],
  ])("shows the receipt refusal %s in its own words, whatever the server's message says", async (code, status, copy) => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [status, { error: code, message: "server wording" }],
    });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl })).rejects.toThrow(copy);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a 5xx whose write committed: the re-read shows it undone, and the token is not used", async () => {
    let reads = 0;
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view(reads++ ? { undoneAt: "now" } : {})] }],
      [UNDO]: () => [502, { error: "undo_failed", message: "lost" }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a dropped answer with the record still open: fails, keeps the token, and the retry asks the server", async () => {
    let attempt = 0;
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => (attempt++ === 0 ? "drop"
        : [409, { error: "undo_already_undone", message: "This was already undone." }]),
    });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
    // The dropped request had committed: the retry learns so and never subtracts again.
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("an unreadable server, for a record this phone stored, fails with the token kept", async () => {
    const api = server({ "POST /api/coach/undo": () => [200, { undo: view() }], "GET /api/coach/undo": () => "drop" });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await vi.waitFor(() => expect(Object.keys(localStorage).some((k) => k.endsWith("coach-undo:stored")))
      .toBe(true));
    resetApplyState(); // a reload: the in-memory record is gone, the stored mark is not
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("an unreadable server, for an action this phone never stored, undoes with the token", async () => {
    const api = server({ "GET /api/coach/undo": () => "drop", "POST /api/coach/undo": () => "drop" });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
  });

  it("uses the token when the server has no record of the action", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [] }],
      "POST /api/coach/undo": () => [404, { error: "unknown_action", message: "none" }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
  });

  it("never applies the token twice on one phone, even when the mark could not be sent", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ kind: "skip_slot", serverUndoable: false })] }],
      "POST /api/coach/undo": () => "drop",
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledTimes(1);
    // A second tap (a stale card, a retry, a reload with the token still cached).
    resetApplyState();
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledTimes(1);
  });

  it("never applies the token twice when the server refused the mark (4xx)", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [] }],
      "POST /api/coach/undo": () => [404, { error: "unknown_action", message: "none" }],
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledTimes(1);
  });

  it("an expired record: the token undoes once, the record is marked, and a second tap does nothing", async () => {
    let marked = false;
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ kind: "skip_slot", expired: true, serverUndoable: false,
        undoneAt: marked ? "now" : null })] }],
      "POST /api/coach/undo": (body) => { marked = body?.undone === true;
        return [200, { undo: view({ expired: true, undoneAt: "now" }) }]; },
    });
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(marked).toBe(true);
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledTimes(1);
  });

  it("two Undos flushing the queue at once send each queued mark once and lose none", async () => {
    const offline = server({ "GET /api/coach/undo": () => [200, { next: null, undos: [] }], "POST /api/coach/undo": () => "drop" });
    await undoCoachAction("act-1", token, { fetchImpl: offline.fetchImpl });
    await undoCoachAction("act-2", { ...token } as UndoToken, { fetchImpl: offline.fetchImpl });
    const posted: string[] = [];
    const online = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [] }],
      "POST /api/coach/undo": (body) => { posted.push(String(body?.actionId)); return [200, { undo: view() }]; },
    });
    const { flushPendingUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    await Promise.all([flushPendingUndos(accountHandle(), { fetchImpl: online.fetchImpl }),
      flushPendingUndos(accountHandle(), { fetchImpl: online.fetchImpl })]);
    expect(posted.sort()).toEqual(["act-1", "act-2"]);
  });

  it("remembers an undone action by age, not by count: 600 later Undos do not forget the first", async () => {
    const { isUndoneHere, noteUndoneHere } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const h = accountHandle();
    noteUndoneHere(h, "first");
    for (let i = 0; i < 600; i += 1) noteUndoneHere(h, `later-${i}`);
    expect(isUndoneHere(h, "first")).toBe(true);
    // Never pruned: years later the mark still stops a retained token.
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 365 * 86_400_000);
    noteUndoneHere(h, "much-later");
    expect(isUndoneHere(h, "first")).toBe(true);
    later.mockRestore();
  });

  it("a server Undo of a logged meal removes it from this phone's day, without a token too", async () => {
    const { addExtra, getDay } = await import("@/lib/store");
    addExtra("2026-10-05", { id: "entry-1", foodId: "meal", name: "Eggs", slot: "meal-1", qty: 1,
      grams: 100, macros: { kcal: 150, protein: 12, carbs: 1, fat: 10 } } as never);
    expect(getDay("2026-10-05")?.extras).toHaveLength(1);
    const meal = view({ kind: "log_meal", target: { date: "2026-10-05", entryId: "entry-1" } });
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [meal] }],
      [UNDO]: () => [200, { undo: { ...meal, undoneAt: "now" }, performed: "server" }],
    });
    await undoCoachAction("act-1", null, { fetchImpl: api.fetchImpl });
    expect(getDay("2026-10-05")?.extras ?? []).toHaveLength(0);
  });

  it("after another device undid it and the record was scrubbed, the tombstone still stops the token", async () => {
    const api = server({
      "POST /api/coach/undo": () => [200, { undo: view() }],
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ undoneAt: "elsewhere", expired: true,
        serverUndoable: false })] }],
    });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await vi.waitFor(() => expect(Object.keys(localStorage).some((k) => k.endsWith("coach-undo:stored")))
      .toBe(true));
    resetApplyState(); // days later, a reload
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a record this phone saw stored that the server no longer lists keeps the token", async () => {
    const api = server({
      "POST /api/coach/undo": () => [200, { undo: view() }],
      "GET /api/coach/undo": () => [200, { next: null, undos: [] }],
    });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: api.fetchImpl });
    await vi.waitFor(() => expect(Object.keys(localStorage).some((k) => k.endsWith("coach-undo:stored")))
      .toBe(true));
    resetApplyState();
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("reads the record fresh before using the token: another tab closed it since the last read", async () => {
    let closed = false;
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view({ serverUndoable: false,
        undoneAt: closed ? "other tab" : null })] }],
    });
    const { listCoachUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    await listCoachUndos(accountHandle(), { actionId: "act-1" }, { fetchImpl: api.fetchImpl });
    closed = true; // another tab undid it locally and marked the record
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("sends a composed card's source with its record, and keeps it on a queued undone mark", async () => {
    const source = { messageId: "3f1b1a2c-0000-4000-8000-000000000011", cardIndex: 0 };
    const flaky = server({ "POST /api/coach/undo": () => [503, { error: "x", message: "x" }],
      "GET /api/coach/undo": () => [200, { next: null, undos: [] }] });
    await applyCoachAction(action, { tz: "UTC", fetchImpl: flaky.fetchImpl, source });
    await vi.waitFor(() => expect(flaky.calls).toHaveLength(1));
    expect(flaky.calls[0].body).toMatchObject({ source });
    await undoCoachAction("act-1", token, { fetchImpl: flaky.fetchImpl });
    expect(mocks.undo).toHaveBeenCalledWith(token);
    const online = server({ "POST /api/coach/undo": () => [200, { undo: view({ undoneAt: "now" }) }] });
    const { flushPendingUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    await flushPendingUndos(accountHandle(), { fetchImpl: online.fetchImpl });
    expect(online.calls[0].body).toMatchObject({ source, undone: true });
  });

  it("a record post that never answers releases the Undo at the deadline, as an unknown outcome", async () => {
    const { DEADLINES } = await import("@/lib/fetch-with-deadline");
    const saved = DEADLINES.undo;
    DEADLINES.undo = 30;
    try {
      const hang = server({ "POST /api/coach/undo": () => new Promise<never>(() => {}),
        "GET /api/coach/undo": () => new Promise<never>(() => {}) });
      await applyCoachAction(action, { tz: "UTC", fetchImpl: hang.fetchImpl });
      await expect(undoCoachAction("act-1", token, { fetchImpl: hang.fetchImpl }))
        .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
      expect(mocks.undo).not.toHaveBeenCalled();
      // The lock was released: a later tap, with the server back, goes through.
      const back = server({
        "POST /api/coach/undo": () => [200, { undo: view() }],
        "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
        [UNDO]: () => [200, { undo: view({ undoneAt: "now" }), performed: "server" }],
      });
      await undoCoachAction("act-1", token, { fetchImpl: back.fetchImpl });
      expect(back.routesOf()).toContain(UNDO);
    } finally { DEADLINES.undo = saved; }
  });

  it("water: a server 'not synced' never lets the token subtract again", async () => {
    const api = server({
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [409, { error: "undo_not_synced", message: "Water has not reached the server yet." }],
    });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("not reached the server");
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("water: a recorded but phone-only water action never uses the token", async () => {
    const api = server({ "GET /api/coach/undo": () => [200, { next: null, undos: [view({ serverUndoable: false })] }] });
    await expect(undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("Edit the count on Today");
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("a stalled response body counts as no answer within the deadline", async () => {
    const { DEADLINES } = await import("@/lib/fetch-with-deadline");
    const saved = DEADLINES.undo;
    DEADLINES.undo = 30;
    try {
      const stalledBody = () => new Response(new ReadableStream({ start() {} }),
        { status: 200, headers: { "content-type": "application/json" } });
      const fetchImpl = vi.fn(async () => stalledBody()) as unknown as typeof fetch;
      await expect(undoCoachAction("act-1", null, { fetchImpl })).rejects.toThrow();
      expect(mocks.undo).not.toHaveBeenCalled();
    } finally { DEADLINES.undo = saved; }
  }, 5_000);

  it("waits only for its own queued record, never behind unrelated stalled posts", async () => {
    const { accountHandle, accountKey } = await import("@/lib/device/account");
    const h = accountHandle();
    const others = ["x", "y", "z"].map((id) => ({ actionId: `act-${id}`, kind: "log_water",
      token: { kind: "log_water" }, undone: false }));
    localStorage.setItem(accountKey(h, "coach-undo:pending"), JSON.stringify(others));
    const api = server({
      "POST /api/coach/undo": () => new Promise<never>(() => {}), // every queued post stalls
      "GET /api/coach/undo": () => [200, { next: null, undos: [view()] }],
      [UNDO]: () => [200, { undo: view({ undoneAt: "now" }), performed: "server" }],
    });
    const started = Date.now();
    await undoCoachAction("act-1", token, { fetchImpl: api.fetchImpl });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(api.routesOf()).not.toContain("POST /api/coach/undo");
  });

  it("the whole server decision has one budget: past it the token is kept and nothing runs", async () => {
    const { undoViaServer } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const hang = server({ "GET /api/coach/undo": () => new Promise<never>(() => {}) });
    await expect(undoViaServer(accountHandle(), "act-1", true, { fetchImpl: hang.fetchImpl, totalMs: 40 }))
      .rejects.toThrow(UNDO_UNCONFIRMED_REASON);
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("fails honestly with neither a server record nor a local token", async () => {
    const api = server({ "GET /api/coach/undo": () => [200, { next: null, undos: [] }] });
    await expect(undoCoachAction("act-1", null, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("only be undone on the phone");
  });
});

describe("paging (review t25 round 2 finding)", () => {
  it("reads one page and carries the server's `before` cursor as `next`", async () => {
    const { listCoachUndosPage } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const api = server({ "GET /api/coach/undo": () => [200, { undos: [view()],
      next: "2026-10-05T12:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d1" }] });
    const page = await listCoachUndosPage(accountHandle(),
      { threadId: "t", before: "2026-10-06T00:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d9" },
      { fetchImpl: api.fetchImpl });
    expect(page.undos).toHaveLength(1);
    expect(page.next).toBe("2026-10-05T12:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d1");
    const url = new URL(api.calls[0].url, "http://x");
    expect(url.searchParams.get("before")).toBe("2026-10-06T00:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d9");
  });

  it("the plain list follows every page to the end (review t25r1 #4)", async () => {
    const { listCoachUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    let page = 0;
    const api = server({ "GET /api/coach/undo": () => {
      page += 1;
      return [200, page === 1
        ? { undos: [view({ actionId: "a1" })], next: "2026-10-05T12:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d1" }
        : { undos: [view({ actionId: "a2" })], next: null }];
    } });
    const all = await listCoachUndos(accountHandle(), { threadId: "t" }, { fetchImpl: api.fetchImpl });
    expect(all.map((u) => u.actionId)).toEqual(["a1", "a2"]);
    expect(new URL(api.calls[1].url, "http://x").searchParams.get("before"))
      .toBe("2026-10-05T12:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d1");
  });

  it("the reviewer's finding: 51 pages of 100 records each are all returned, none dropped", async () => {
    const { listCoachUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const TOTAL_PAGES = 51;
    const PAGE_SIZE = 100;
    // Reads the `before` cursor from the request URL to hand back the matching page — a plain
    // fetch stand-in (not the `server()` helper above, which only dispatches by method+path).
    const fetchImpl = vi.fn(async (input: string) => {
      const url = new URL(input, "http://x");
      const before = url.searchParams.get("before");
      const pageIndex = before === null ? 0 : Number(before.split(":")[1]);
      const undos = Array.from({ length: PAGE_SIZE }, (_, i) =>
        view({ actionId: `bulk-${pageIndex}-${i}` }));
      const next = pageIndex + 1 < TOTAL_PAGES ? `cursor:${pageIndex + 1}` : null;
      return new Response(JSON.stringify({ undos, next }),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    const all = await listCoachUndos(accountHandle(), { threadId: "t" },
      { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(all).toHaveLength(TOTAL_PAGES * PAGE_SIZE);
    expect(new Set(all.map((u) => u.actionId)).size).toBe(TOTAL_PAGES * PAGE_SIZE);
    expect(fetchImpl).toHaveBeenCalledTimes(TOTAL_PAGES);
  });

  it("a page without `next` fails rather than being read as the end of the list", async () => {
    const { listCoachUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const api = server({ "GET /api/coach/undo": () => [200, { undos: [view()] }] });
    await expect(listCoachUndos(accountHandle(), { threadId: "t" }, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("Could not read the undo records.");
  });

  it("an absurd number of pages fails explicitly rather than silently returning a partial list", async () => {
    const { listCoachUndos } = await import("@/lib/coach/undo-client");
    const { accountHandle } = await import("@/lib/device/account");
    const api = server({ "GET /api/coach/undo": () =>
      [200, { undos: [view()], next: "2026-10-05T12:00:00.000Z,3f1b1a2c-0000-4000-8000-0000000000d1" }] });
    await expect(listCoachUndos(accountHandle(), { threadId: "t" }, { fetchImpl: api.fetchImpl }))
      .rejects.toThrow("Too many undo records");
  });
});
