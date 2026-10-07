/**
 * T0 §1 / AC1 — the marks are actually on the real hops, and a run closes as ONE row set.
 *
 * Each client owns the hops it makes: capture-client the sign/upload/propose legs plus the
 * server's own ms, barcode-client the lookup, log-commit-client the commit and the moment the card went
 * up. Whoever commits closes the run, so a barcode scan's decode, lookup and commit all carry the
 * same `run_id` — which is what makes `pnpm timings --path barcode` a table about one tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMedia, captureText } from "@/lib/capture-client";
import { scanGtin } from "@/lib/barcode/client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { beginRun, buffered, mark, resetTimings } from "@/lib/timing";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetTestAccount } from "@/tests/helpers/account";

vi.mock("@/lib/sync/outbox", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/lib/sync/idb", () => {
  const openAccountDb = vi.fn(async (_h?: unknown) => ({
    get: async (..._args: unknown[]): Promise<unknown[]> => [],
    put: async (..._args: unknown[]): Promise<undefined> => undefined,
  }));
  return {
    allOps: vi.fn(async () => []), putRow: vi.fn(async () => undefined),
    getRow: vi.fn(async () => undefined), deleteRow: vi.fn(async () => undefined),
    // Routed through `openAccountDb`, not stubbed on their own: the pending record `markInFlight`
    // writes is read through it too, and a test that slows `openAccountDb` down (below) means that
    // slowness for real.
    getMeta: vi.fn(async (h: unknown, key: string) => (await openAccountDb(h)).get("meta", key)),
    putMeta: vi.fn(async (h: unknown, key: string, value: unknown) => {
      await (await openAccountDb(h)).put("meta", value, key);
    }),
    closeAllAccountDbs: vi.fn(async () => undefined),
    META_STORE: "meta",
    openAccountDb,
  };
});
vi.mock("@/lib/store", () => ({
  addExtra: vi.fn(), getDay: vi.fn(() => undefined), removeExtra: vi.fn(),
  updateExtra: vi.fn(), upsertExtra: vi.fn(),
}));
/** The authoritative read this file answers with — null unless a test says otherwise. */
let serverRead: Record<string, unknown> | null = null;
function readsDeletedRow(): void {
  serverRead = { id: "44444444-4444-4444-8444-444444444444", rev: 3, local_date: "2026-09-17",
    deleted_at: "2026-09-17T18:00:00.000Z", items: [] };
}

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: serverRead, error: null }) }) }) }),
  }),
}));

const CTX = { localDate: "2026-09-17", tz: "America/New_York", slot: "meal-2" as const };

const DRAFT = {
  draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b10", method: "photo", notes: [], items: [],
  spend: { usedToday: 1, softCap: 30 }, timings: { model: 1800, ground: 240 },
};

const REQ: LogCommitRequest = {
  entry_id: "aaaaaaaa-1111-4111-8111-111111111111",
  eaten_at: "2026-09-17T12:00:00.000Z", tz: "UTC", local_date: "2026-09-17",
  slot: "meal-2", method: "search",
  items: [{ id: "bbbbbbbb-2222-4222-8222-222222222222", seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 100 }],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A promise plus the function that settles it, for hand-sequencing a test around a mock. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const steps = () => buffered().map((r) => r.step);

/** `card-visible` only exists where a card was written before the post — the optimistic path. */
const OPTIMISTIC = {
  date: "2026-09-17",
  entry: { id: REQ.entry_id, foodId: "rice", name: "Rice", portionLabel: "100 g", qty: 1,
    grams: 100, macros: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, at: REQ.eaten_at },
};

beforeEach(async () => { resetTimings(); serverRead = null; await resetTestAccount(); });
afterEach(() => { resetTimings(); vi.restoreAllMocks(); });

describe("a search-log run", () => {
  it("closes as one run carrying the commit and the moment the card went up", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl, timingPath: "search-log", optimistic: OPTIMISTIC });
    expect(steps()).toContain("commit");
    expect(steps()).toContain("card-visible");
    expect(new Set(buffered().map((r) => r.run_id)).size).toBe(1);
  });

  it("keeps the card-visible sample when the commit ends in the outbox, and only that", async () => {
    // The commit has not happened — it happens later, when the drain sends it — so there is no
    // `commit` sample to file. The card DID go up, and §6 budgets exactly that: tap to card, on
    // the server-down path as much as the happy one (Grok pass 6, MEDIUM 5).
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, timingPath: "search-log", optimistic: OPTIMISTIC });
    expect(steps()).toContain("card-visible");
    expect(steps()).not.toContain("commit");
  });

  it("measures the card from the tap, not from the writes behind it", async () => {
    // §6 budgets tap-to-card, and the card is on Today the moment the store is written. The
    // sample was taken after the mirror read, the record write, the outbox write and the mirror
    // write, so a slow database made the card look slow when it had been up all along
    // (Grok pass 20, MEDIUM 3).
    const idb = await import("@/lib/sync/idb");
    vi.mocked(idb.getRow).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return undefined;
    });
    const fetchImpl = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;

    await commitLogEntry(REQ, { fetchImpl, timingPath: "search-log", optimistic: OPTIMISTIC });

    const card = buffered().find((r) => r.step === "card-visible");
    expect(card).toBeDefined();
    expect(card?.ms).toBeLessThan(80);
  });

  it("counts the record the card cannot exist without, and nothing after the card", async () => {
    // The record is part of the paint — there is no card without one — and the outbox and mirror
    // writes are not: they happen behind a card that is already up (Grok pass 21, MEDIUM 2).
    //
    // What this proves, in order: (1) the commit reaches and blocks inside the idb hop
    // (markInFlight → openAccountDb) before anything about the card is fixed; (2) once that hop
    // resolves, the commit reaches and blocks inside the OUTBOX hop (writeLocalFirst → queue →
    // enqueue) — which happens strictly after `since(tapped)` is read for the card's own sample —
    // while the whole commit is still pending, because writeLocalFirst awaits the outbox before
    // the POST is even sent; (3) the card's sample is already the idb-hop's value at that point,
    // and jumping the clock far forward before letting the outbox hop resolve proves nothing reads
    // the clock again afterward for that sample. A real-clock window can only ever bound the
    // measured ms, never prove WHERE it was taken — a regression that moved the `since(tapped)`
    // read to after the outbox write could still land inside a wide window. So there is no
    // setTimeout and no fake-timer advancement here at all: `performance.now()` is stubbed with a
    // clock this test moves by hand, and each hop's mock signals a "reached" deferred the instant
    // it is called (before it awaits its own gate), so the test waits on those signals — never on
    // a guessed number of microtask turns — to know exactly when it is safe to move the clock or
    // inspect `settled`.
    const idb = await import("@/lib/sync/idb");
    const outbox = await import("@/lib/sync/outbox");

    let clock = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const idbGate = deferred<void>();
      const reachedIdb = deferred<void>();
      const outboxGate = deferred<void>();
      const reachedOutbox = deferred<void>();

      vi.mocked(idb.openAccountDb).mockImplementation(async () => {
        reachedIdb.resolve();
        await idbGate.promise;
        return { get: async () => [], put: async () => undefined } as never;
      });
      vi.mocked(outbox.enqueue).mockImplementation(async () => {
        reachedOutbox.resolve();
        await outboxGate.promise;
        return undefined as never;
      });
      const fetchImpl = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
        items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;

      let settled = false;
      const resultPromise = commitLogEntry(REQ,
        { fetchImpl, timingPath: "search-log", optimistic: OPTIMISTIC }).then((r) => {
        settled = true;
        return r;
      });

      // (1) Blocked inside the idb hop. Let it resolve at simulated t=30 — the only elapsed time
      // the card's sample may count.
      await reachedIdb.promise;
      clock = 30;
      idbGate.resolve();

      // (2) The idb hop's own continuation and the card's `since(tapped)` read are both ahead of
      // the outbox call in the source (lib/log-commit-client.ts: recordFirst resolves, cardMs is
      // read, THEN writeLocalFirst runs and calls queue→enqueue) — so reaching the outbox hop
      // proves the card's sample is already fixed. The commit is still pending, because
      // writeLocalFirst awaits the outbox before the POST is sent — proving the card did not wait
      // on it either.
      await reachedOutbox.promise;
      expect(settled).toBe(false);

      // (3) Move the clock far past any plausible value and only THEN let the outbox hop resolve.
      // If a regression ever reads `performance.now()` again after this point for the card's
      // sample, the assertion below catches it exactly rather than by getting lucky against a
      // window.
      clock = 999_999;
      outboxGate.resolve();
      await resultPromise;

      const card = buffered().find((r) => r.step === "card-visible");
      expect(card?.ms).toBe(30);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("files no sample at all when there was no card either", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, timingPath: "search-log" });
    expect(buffered()).toHaveLength(0);
  });

  it("keeps the card-visible sample for a commit the server asked to be retried", async () => {
    const busy = vi.fn(async () => json({ error: "down" }, 503)) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: busy, timingPath: "search-log", optimistic: OPTIMISTIC });
    expect(steps()).toEqual(["card-visible"]);
  });

  it("measures a commit whose entry turned out to be deleted", async () => {
    // The tombstone path returns early, and it returned before the run was closed: a tap that
    // reached the server and came back measured nothing at all (Grok pass 7, LOW 5).
    readsDeletedRow();
    const ok = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: ok, timingPath: "search-log", optimistic: OPTIMISTIC });
    expect(steps()).toContain("commit");
  });

  it("keeps two overlapping search commits in two runs", async () => {
    // Nothing threaded a run here, so both commits shared `currentByPath` and one's close took the
    // other's marks with it (Grok pass 6, MEDIUM 5).
    const first = beginRun("search-log");
    const second = beginRun("search-log");
    const ok = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: ok, timingPath: "search-log", optimistic: OPTIMISTIC, run: first });
    await commitLogEntry(REQ, { fetchImpl: ok, timingPath: "search-log", optimistic: OPTIMISTIC, run: second });
    expect(new Set(buffered().map((r) => r.run_id)).size).toBe(2);
  });

  it("measures nothing when the caller named no path", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl });
    expect(buffered()).toHaveLength(0);
  });
});

describe("a barcode run", () => {
  it("keeps the scanner's decode, the lookup and the commit in one row set", async () => {
    mark("barcode", "decode");                      // the scanner, when the camera goes live
    const scanFetch = vi.fn(async () => json({ status: "not_found", gtin14: "04006381333931",
      searchHint: {} })) as unknown as typeof fetch;
    await scanGtin({ gtin: "04006381333931" }, { fetchImpl: scanFetch });
    const commitFetch = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry({ ...REQ, method: "barcode" }, { fetchImpl: commitFetch, timingPath: "barcode" });
    expect(steps()).toEqual(expect.arrayContaining(["decode", "lookup", "commit"]));
    expect(new Set(buffered().map((r) => r.run_id)).size).toBe(1);
    expect(new Set(buffered().map((r) => r.path))).toEqual(new Set(["barcode"]));
  });
});

describe("two scans at once", () => {
  it("keeps each scan's lookup and commit under its own run", async () => {
    // `beginRun` existed and nothing used it: every call site marked bare, so a second barcode
    // scanned while the first was still resolving joined the first one's run and the two taps
    // came out as one row set (Grok pass 5, LOW). The handle is threaded now.
    const scanFetch = vi.fn(async () => json({ status: "not_found", gtin14: "04006381333931",
      searchHint: {} })) as unknown as typeof fetch;
    const commitFetch = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;

    const first = beginRun("barcode");
    mark("barcode", "decode", first);
    const second = beginRun("barcode");
    mark("barcode", "decode", second);
    await scanGtin({ gtin: "04006381333931" }, { fetchImpl: scanFetch, run: first });
    await scanGtin({ gtin: "04006381333931" }, { fetchImpl: scanFetch, run: second });
    await commitLogEntry({ ...REQ, method: "barcode" },
      { fetchImpl: commitFetch, timingPath: "barcode", run: first });
    await commitLogEntry({ ...REQ, method: "barcode" },
      { fetchImpl: commitFetch, timingPath: "barcode", run: second });

    const runs = new Map<string, string[]>();
    for (const row of buffered()) runs.set(row.run_id, [...(runs.get(row.run_id) ?? []), row.step]);
    expect(runs.size).toBe(2);
    for (const steps of runs.values()) {
      expect(steps).toEqual(expect.arrayContaining(["decode", "lookup", "commit"]));
      expect(steps.filter((step) => step === "lookup")).toHaveLength(1);
    }
  });
});

describe("two captures at once", () => {
  it("keeps each capture's propose and commit under its own run", async () => {
    const fetchImpl = vi.fn(async () => json(DRAFT)) as unknown as typeof fetch;
    const first = await captureText("two eggs", { ...CTX, fetchFn: fetchImpl });
    const second = await captureText("a banana", { ...CTX, fetchFn: fetchImpl });
    expect(first.kind).toBe("draft");
    expect(second.kind).toBe("draft");
    if (first.kind !== "draft" || second.kind !== "draft") return;
    expect(first.run?.key).not.toBe(second.run?.key);

    const commitFetch = vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
      items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch;
    await commitLogEntry({ ...REQ, method: "text" },
      { fetchImpl: commitFetch, timingPath: "text", run: first.run });
    await commitLogEntry({ ...REQ, method: "text" },
      { fetchImpl: commitFetch, timingPath: "text", run: second.run });
    const runs = new Map<string, string[]>();
    for (const row of buffered()) runs.set(row.run_id, [...(runs.get(row.run_id) ?? []), row.step]);
    expect(runs.size).toBe(2);
    for (const steps of runs.values()) expect(steps).toContain("propose");
  });
});

describe("a capture run", () => {
  it("marks the propose leg and files the server's own model and ground ms with it", async () => {
    const fetchImpl = vi.fn(async () => json(DRAFT)) as unknown as typeof fetch;
    await captureText("two eggs", { ...CTX, fetchFn: fetchImpl });
    await commitLogEntry({ ...REQ, method: "text" }, { fetchImpl, timingPath: "text" });
    const byStep = new Map(buffered().map((r) => [r.step, r.ms]));
    expect(byStep.has("propose")).toBe(true);
    expect(byStep.get("model")).toBe(1800);
    expect(byStep.get("ground")).toBe(240);
  });

  it("marks sign, upload and propose on the media path", async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input) === "/api/media/sign"
        ? json({ path: "media/u1/a.jpg", uploadUrl: "https://s.test/u", expiresInSeconds: 60 })
        : json(DRAFT)) as unknown as typeof fetch;
    await captureMedia("photo", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn: fetchImpl });
    await commitLogEntry({ ...REQ, method: "photo" }, { fetchImpl, timingPath: "photo" });
    expect(steps()).toEqual(expect.arrayContaining(["sign", "upload", "propose"]));
  });

  it("closes its own run when a hop fails, so the next capture starts clean", async () => {
    // A capture that dies on the sign hop left its run open on the path. The next bare mark on
    // that path joined it, and the failed tap's `sign` was filed with the next tap's numbers
    // (Grok pass 25, LOW 4).
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const failed = await captureMedia("photo", new Blob(["x"], { type: "image/jpeg" }),
      { ...CTX, fetchFn: down });
    expect(failed.kind).toBe("error");

    // Nothing of that run is left for the page: a bare mark starts a run of its own.
    mark("photo", "commit");
    await commitLogEntry({ ...REQ, method: "photo" }, {
      fetchImpl: vi.fn(async () => json({ status: "ok", entry_id: REQ.entry_id, rev: 1,
        items: [], totals: { local_date: "2026-09-17", nutrients: [], micro_coverage_pct: 0 } })) as unknown as typeof fetch,
      timingPath: "photo",
    });
    expect(steps()).not.toContain("sign");
  });

  it("tells the sheet which step it is on, so the working line can name it", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input) === "/api/media/sign"
        ? json({ path: "media/u1/a.jpg", uploadUrl: "https://s.test/u", expiresInSeconds: 60 })
        : json(DRAFT)) as unknown as typeof fetch;
    await captureMedia("label", new Blob(["x"], { type: "image/jpeg" }),
      { ...CTX, fetchFn: fetchImpl, onStep: (s) => seen.push(s) });
    expect(seen).toEqual(["sign", "upload", "propose"]);
  });
});
