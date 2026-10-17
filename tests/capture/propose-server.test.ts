import { withSpendRpc } from "@/tests/ai/spend-admin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCapture } from "@/lib/ai/capture";
import { proposeRequestSchema } from "@/lib/capture/types";
import { proposeDraft } from "@/lib/server/capture";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

/** An awaited query result that a paged read can still chain `.order()`/`.range()` onto. */
function settled(value: unknown) {
  const query: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
  query.order = () => query;
  query.range = () => query;
  return query;
}

const REQ = { method: "text" as const, localDate: "2026-09-11", tz: "America/New_York",
  slot: "meal-1", text: "two eggs" };
const HIT = { catalogFoodId: 7, revisionId: 70, description: "Egg, whole, raw", brand: null,
  source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: null,
  score: 0.9, prefStatus: "eats", policyCategories: [], policy: { verdict: "allowed" } };

const DEFAULT_MEDIA_OBJECT = { path: "unused", user_id: "u1", deleted_at: null as string | null };

/**
 * The account's own rules, as its `constraint_profiles` row. The banned categories and allergens
 * these cases block on used to come from a constant in code; since D1 §6.1 the account's row is the
 * only place a restriction exists (lib/server/catalog.ts:130-135, the profile the item policy reads).
 */
const RULES = { user_id: "u1", ...DEFAULT_PROFILE };

/** Only the surface proposeDraft uses: two rpcs, three table reads, one insert. */
function fakeDb(opts: { today?: number; duplicate?: { id: string } | null; portions?: unknown[];
  portionRows?: unknown[]; portionsError?: boolean; mediaObject?: typeof DEFAULT_MEDIA_OBJECT | null; mediaObjectError?: boolean;
  constraints?: Record<string, unknown> | null; timeZone?: string | null } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === "ai_calls_today") return { data: opts.today ?? 0, error: null };
    if (name === "get_or_create_food_ref") return { data: "ref-70", error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "neq", "gte", "order", "limit"]) chain[m] = vi.fn(self);
    // The paged ingredient read (t18) resolves at `.range()`: an empty, successful read.
    chain.range = vi.fn(() => settled({ data: [], error: null }));
    // catalog_portions.eq resolves a real query result (portionsFor awaits it directly); every
    // other table's eq keeps chaining, since those callers chain further before resolving.
    chain.eq = table === "catalog_portions" && opts.portionsError
      ? vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      : table === "catalog_portions" && opts.portionRows
        ? vi.fn().mockResolvedValue({ data: opts.portionRows, error: null })
        : vi.fn(self);
    // The ai_calls duplicate probe chains past `.in("purpose", [twin pair])`; every other table's
    // `in` resolves a query result.
    chain.in = table === "ai_calls" ? vi.fn(self)
      : vi.fn(() => settled({ data: opts.portions ?? [], error: null }));
    chain.maybeSingle = vi.fn().mockResolvedValue(
      table === "ai_calls" ? { data: opts.duplicate ?? null, error: null }
      : table === "media_objects" ? (opts.mediaObjectError
          ? { data: null, error: { message: "boom" } }
          : { data: opts.mediaObject === undefined ? DEFAULT_MEDIA_OBJECT : opts.mediaObject, error: null })
      : table === "constraint_profiles" ? { data: opts.constraints ?? null, error: null }
      : table === "user_settings" ? { data: opts.timeZone ? { time_zone: opts.timeZone } : null, error: null }
      : { data: null, error: null });
    chain.insert = vi.fn(async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; });
    return chain;
  });
  return { inserts, rpc, client: withSpendRpc({ rpc, from }) as never };
}

const captureOk = vi.fn(async () => ({
  items: [{ label: "eggs", grams: 100, qty: 2, unit: "whole", confidence: 0.8 }], notes: [] }));
/** A "cup" item: with no portion row to size it, gramsFor has nothing to multiply and returns
 * null, so this is the fixture that shows the model's own grams surviving unchanged. */
const captureCup = vi.fn(async () => ({
  items: [{ label: "cottage cheese", grams: 227, qty: 1, unit: "cup", confidence: 0.7 }], notes: [] }));
const searchOk = vi.fn(async () => ({ hits: [HIT], queryClass: "generic", autoResolve: null,
  catalogVersion: "v1" }));
/** A second, lower-scored hit so the pair honestly clears the 0.95/0.30 auto-resolve gate. */
const searchAutoResolve = vi.fn(async () => ({
  hits: [{ ...HIT, score: 0.96 }, { ...HIT, catalogFoodId: 8, revisionId: 80,
    description: "Egg, white, raw", score: 0.6 }],
  queryClass: "generic", autoResolve: null, catalogVersion: "v1" }));

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo"); });

describe("proposeDraft", () => {
  it("accepts a slot-less request through the real propose schema and pipeline", async () => {
    const db = fakeDb();
    const modelCall = vi.fn(async (_model: string, _parts: { text?: string }[]) => ({
      text: JSON.stringify({ items: [], notes: [] }), inputTokens: 1, outputTokens: 1,
    }));
    const captureWithMockedModel: typeof runCapture = (payload, ctx) =>
      runCapture(payload, ctx, { sleep: async () => {}, callGemini: modelCall });
    const request = proposeRequestSchema.parse({
      method: "text", localDate: "2026-09-11", tz: "America/New_York", text: "two eggs",
    });

    const out = await proposeDraft(db.client, db.client, "u1", request, {
      runCapture: captureWithMockedModel,
    });

    const parts = modelCall.mock.calls[0][1];
    expect(JSON.parse(parts[1].text as string)).toEqual({
      data: { text: "two eggs" }, localDate: "2026-09-11",
    });
    expect(out).toMatchObject({ method: "text", items: [] });
  });

  it("refuses photo capture with 503 nous_unconfirmed before the media is read, when not attested", async () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const db = fakeDb();
    const fetchOwnedObject = vi.fn();
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", mediaPath: "media/u1/a.jpg" } as never,
      { runCapture: captureOk as never, fetchOwnedObject: fetchOwnedObject as never }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(fetchOwnedObject).not.toHaveBeenCalled();
    expect(captureOk).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
  });

  it("refuses text capture through the real adapter, reaching no provider, when not attested", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    const db = fakeDb();
    const modelCall = vi.fn();
    await expect(proposeDraft(db.client, db.client, "u1", REQ, {
      runCapture: (payload, ctx) => runCapture(payload, ctx, { callGemini: modelCall }),
    })).rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(modelCall).not.toHaveBeenCalled();
  });

  it("404s a method that is not enabled, before any provider call", async () => {
    vi.stubEnv("CAPTURE_METHODS", "text");
    const db = fakeDb();
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", mediaPath: "media/u1/a.jpg" } as never,
      { runCapture: captureOk as never }))
      .rejects.toMatchObject({ status: 404, code: "method_disabled" });
    expect(captureOk).not.toHaveBeenCalled();
  });

  it("409s a repeat inside ten minutes and names the original ai_calls row", async () => {
    const db = fakeDb({ duplicate: { id: "call-1" } });
    const rejection = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: searchOk as never }).catch((e) => e);
    expect(rejection).toMatchObject({ status: 409, code: "duplicate_request", aiCallId: "call-1" });
  });

  it("429s at the hard cap and writes a blocked ai_calls row", async () => {
    vi.stubEnv("CAPTURE_DAILY_HARD_CAP", "100");
    const db = fakeDb({ today: 100 });
    await expect(proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never })).rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(db.inserts[0]).toMatchObject({
      user_id: "u1", purpose: "textToItems", status: "blocked", model_id: "gemini-3.8-flash",
    });
    expect(db.inserts[0].sdk_version).not.toBe("n/a");
  });

  it("warns instead of refusing at the soft cap", async () => {
    vi.stubEnv("CAPTURE_DAILY_SOFT_CAP", "30");
    const db = fakeDb({ today: 31 });
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: searchOk as never });
    expect(out.spend).toEqual({ usedToday: 31, softCap: 30 });
    expect(out.notes.join(" ")).toMatch(/logged a lot today/);
  });

  it("grounds an item, resolves its ref and judges it", async () => {
    const db = fakeDb();
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: searchAutoResolve as never });
    expect(out.method).toBe("text");
    expect(out.items[0]).toMatchObject({
      seq: 0, label: "eggs", foodRefId: "ref-70", catalogFoodRevisionId: 70, qty: 2, unit: "whole",
      autoResolved: true,
    });
    expect(out.items[0].policy.verdict).toBe("allowed");
  });

  it("blocks an item whose top hit carries a banned policy category", async () => {
    // The hit knows its categories now (T1 round 2); grounding used to hand the policy `null` and
    // drop the evidence on the floor.
    const search = vi.fn(async () => ({
      hits: [{ ...HIT, description: "Onions, raw", prefStatus: null, score: 0.96,
        policyCategories: ["onion_garlic"] },
        { ...HIT, catalogFoodId: 8, revisionId: 80, prefStatus: null, score: 0.6,
          policyCategories: [] }],
      queryClass: "generic", autoResolve: null, catalogVersion: "v1",
    }));
    const db = fakeDb({ constraints: RULES });
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: search as never });
    expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("blocks nothing the account has not named (no constraint_profiles row)", async () => {
    // The same banned-category hit as the case above, for an account whose row does not exist yet:
    // the category is not one it banned, because no row bans anything (D1 §6.1).
    const search = vi.fn(async () => ({
      hits: [{ ...HIT, description: "Onions, raw", prefStatus: null, score: 0.96,
        policyCategories: ["onion_garlic"] },
        { ...HIT, catalogFoodId: 8, revisionId: 80, prefStatus: null, score: 0.6,
          policyCategories: [] }],
      queryClass: "generic", autoResolve: null, catalogVersion: "v1",
    }));
    const db = fakeDb();
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: search as never });
    expect(out.items[0].policy).toMatchObject({ verdict: "unverified" });
  });

  it("leaves an item ungrounded with alternatives when the search does not auto-resolve", async () => {
    const db = fakeDb();
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureOk as never, searchFoods: searchOk as never });
    expect(out.items[0].foodRefId).toBeNull();
    expect(out.items[0].catalogFoodRevisionId).toBeNull();
    expect(out.items[0].autoResolved).toBe(false);
    expect(out.items[0].alternatives).toEqual([{ foodRefId: "ref-70", catalogFoodRevisionId: 70,
      label: "Egg, whole, raw", score: 0.9 }]);
  });

  it("keeps the model's grams for a count with no matching portion row, never 100 g a piece (A007, A044)", async () => {
    const shrimp = vi.fn(async () => ({
      items: [{ label: "shrimp", grams: 120, qty: 8, unit: "piece", confidence: 0.8 }], notes: [] }));
    const db = fakeDb({ portionRows: [{ id: 3, description: "1 large", gram_weight: 6 }] });
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: shrimp as never, searchFoods: searchOk as never });
    expect(out.items[0].grams).toBe(120);
    expect(out.items[0].portionId).toBeNull();
  });

  it("weighs a cup from a '0.5 cup' portion row as the label's amount, not one unit (A006)", async () => {
    const db = fakeDb({ portionRows: [{ id: 4, description: "0.5 cup", gram_weight: 113 }] });
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureCup as never, searchFoods: searchOk as never });
    expect(out.items[0].grams).toBe(226);
    expect(out.items[0].portionId).toBe(4);
  });

  it("logs but still returns a draft, keeping the model's grams, when the portions lookup errors", async () => {
    const db = fakeDb({ portionsError: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await proposeDraft(db.client, db.client, "u1", REQ,
      { runCapture: captureCup as never, searchFoods: searchOk as never });
    expect(out.items[0].grams).toBe(227);
    expect(spy).toHaveBeenCalledWith("catalog_portions read failed",
      { revisionId: 70, error: { message: "boom" } });
    spy.mockRestore();
  });

  it("returns a draft with zero items when the model output fails the schema", async () => {
    const db = fakeDb();
    const failing = vi.fn(async () => { throw new HttpErrorLike(); });
    class HttpErrorLike extends Error { status = 422; code = "schema_invalid"; }
    await expect(proposeDraft(db.client, db.client, "u1", REQ, { runCapture: failing as never }))
      .rejects.toMatchObject({ status: 422, code: "schema_invalid" });
  });

  it("403s a mediaPath under another uid without downloading it", async () => {
    const db = fakeDb();
    const fetchOwned = vi.fn(async () => { throw Object.assign(new Error("nope"),
      { status: 403, code: "media_not_owned" }); });
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", text: undefined, mediaPath: "media/u2/a.jpg" } as never,
      { runCapture: captureOk as never, fetchOwnedObject: fetchOwned as never }))
      .rejects.toMatchObject({ status: 403, code: "media_not_owned" });
    expect(captureOk).not.toHaveBeenCalled();
  });

  it("403s a mediaPath with no live media_objects row, without downloading it", async () => {
    const db = fakeDb({ mediaObject: null });
    const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/jpeg" }));
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", text: undefined, mediaPath: "media/u1/a.jpg" } as never,
      { runCapture: captureOk as never, fetchOwnedObject: fetchOwned as never }))
      .rejects.toMatchObject({ status: 403, code: "media_not_owned" });
    expect(fetchOwned).not.toHaveBeenCalled();
    expect(captureOk).not.toHaveBeenCalled();
  });

  it("403s a mediaPath whose media_objects row is tombstoned, without downloading it", async () => {
    const db = fakeDb({ mediaObject: { path: "media/u1/a.jpg", user_id: "u1",
      deleted_at: "2026-09-10T00:00:00.000Z" } });
    const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/jpeg" }));
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", text: undefined, mediaPath: "media/u1/a.jpg" } as never,
      { runCapture: captureOk as never, fetchOwnedObject: fetchOwned as never }))
      .rejects.toMatchObject({ status: 403, code: "media_not_owned" });
    expect(fetchOwned).not.toHaveBeenCalled();
    expect(captureOk).not.toHaveBeenCalled();
  });

  it("503s when the media_objects read errors, without downloading it", async () => {
    const db = fakeDb({ mediaObjectError: true });
    const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/jpeg" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(proposeDraft(db.client, db.client, "u1",
      { ...REQ, method: "photo", text: undefined, mediaPath: "media/u1/a.jpg" } as never,
      { runCapture: captureOk as never, fetchOwnedObject: fetchOwned as never }))
      .rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(fetchOwned).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("400s an unrecognised tz before any provider call", async () => {
    const db = fakeDb();
    await expect(proposeDraft(db.client, db.client, "u1", { ...REQ, tz: "Nope/Nope" },
      { runCapture: captureOk as never }))
      .rejects.toMatchObject({ status: 400, code: "bad_request" });
    expect(captureOk).not.toHaveBeenCalled();
  });

  it("503s and logs when the daily cap RPC errors, never treating the error as zero", async () => {
    const db = fakeDb();
    (db.client as Record<string, unknown>).rpc = vi.fn(async (name: string) => {
      if (name === "ai_calls_today") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(proposeDraft(db.client, db.client, "u1", REQ, { runCapture: captureOk as never }))
      .rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(captureOk).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("ai_calls_today failed",
      { userId: "u1", error: { message: "boom" } });
    spy.mockRestore();
  });

  // Audit A143: the request's zone never sets the day the cap counts.
  it("counts the daily cap in the account's stored zone, not the zone the request names", async () => {
    const db = fakeDb({ timeZone: "America/Denver" });
    const rpc = db.rpc;
    await proposeDraft(db.client, db.client, "u1", { ...REQ, tz: "Pacific/Kiritimati" },
      { runCapture: captureOk as never, searchFoods: searchOk as never });
    expect(rpc).toHaveBeenCalledWith("ai_calls_today", { p_user_id: "u1", p_tz: "America/Denver" });
  });

  it("counts the daily cap by UTC, logged, for an account with no stored zone", async () => {
    const db = fakeDb();
    const rpc = db.rpc;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await proposeDraft(db.client, db.client, "u1", { ...REQ, tz: "Pacific/Kiritimati" },
      { runCapture: captureOk as never, searchFoods: searchOk as never });
    expect(rpc).toHaveBeenCalledWith("ai_calls_today", { p_user_id: "u1", p_tz: "UTC" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture cap"));
    warn.mockRestore();
  });

  it("blocks a label whose ingredients name an allergen and derives the draftId from the media uuid", async () => {
    const db = fakeDb({ constraints: RULES });
    const labelCapture = vi.fn(async () => ({
      name: "Snack Bar", servingGrams: 40, per100g: {}, ingredientsText: "apples, water",
    }));
    const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/png" }));
    const out = await proposeDraft(db.client, db.client, "u1", {
      method: "label" as const, localDate: "2026-09-11", tz: "America/New_York", slot: "meal-1",
      mediaPath: "media/u1/22222222-2222-4222-8222-222222222222.jpg",
    }, { runCapture: labelCapture as never, searchFoods: searchOk as never, fetchOwnedObject: fetchOwned as never });
    expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:apple" });
    expect(out.labelFood?.allergenTags).toEqual(["apple"]);
    expect(out.draftId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("warns on the capture card, right after the label is read, in label words (Phase 13 §5)", async () => {
    const db = fakeDb({ constraints: { ...RULES, avoid_allergens: ["dairy", "sesame", "gluten"] } });
    const labelCapture = vi.fn(async () => ({
      name: "Rice crackers", servingGrams: 30, per100g: {},
      ingredientsText: "Rice flour, sunflower oil, sesame seeds, salt.",
    }));
    const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/png" }));
    const out = await proposeDraft(db.client, db.client, "u1", {
      method: "label" as const, localDate: "2026-09-11", tz: "America/New_York", slot: "meal-1",
      mediaPath: "media/u1/33333333-3333-4333-8333-333333333333.jpg",
    }, { runCapture: labelCapture as never, searchFoods: searchOk as never, fetchOwnedObject: fetchOwned as never });
    expect(out.labelFood?.allergenWarnings).toEqual([
      { allergen: "dairy", outcome: "absent", text: "No dairy listed on the label" },
      { allergen: "sesame", outcome: "present", text: "Contains sesame" },
      // Gluten is not one of the nine, so silence never clears it (§9 R1).
      { allergen: "gluten", outcome: "unknown", text: expect.stringMatching(/^No gluten listed, but labels need not declare it/) },
    ]);
    expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
    expect(JSON.stringify(out.labelFood).toLowerCase()).not.toContain("safe");
  });

  describe("finding #2: a label capture grounded to a catalog revision merges that revision's " +
    "stored evidence, never discards it", () => {
    /** Routes `.in()`/`.maybeSingle()` per table, unlike `fakeDb`'s one shared `.in()` mock —
     * this test needs `food_allergen_evidence` to answer differently from `catalog_portions`. */
    function fakeDbWithStoredEvidence(
      evidenceRows: { food_key: string; allergen: string; level: string; label_complete: boolean }[],
    ) {
      const from = vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        for (const m of ["select", "neq", "gte", "order", "limit", "eq"]) chain[m] = vi.fn(self);
        // The paged ingredient read (t18) resolves at `.range()`: an empty, successful read.
        chain.range = vi.fn(() => settled({ data: [], error: null }));
        chain.in = table === "ai_calls" ? vi.fn(self) : vi.fn(() => settled(
          table === "food_allergen_evidence" ? { data: evidenceRows, error: null }
            : { data: [], error: null }));
        chain.maybeSingle = vi.fn().mockResolvedValue(
          table === "media_objects" ? { data: DEFAULT_MEDIA_OBJECT, error: null }
            : table === "constraint_profiles"
              ? { data: { ...RULES, avoid_allergens: ["sesame"] }, error: null }
              : { data: null, error: null });
        chain.insert = vi.fn(async () => ({ error: null }));
        return chain;
      });
      const rpc = vi.fn(async (name: string) => {
        if (name === "ai_calls_today") return { data: 0, error: null };
        if (name === "get_or_create_food_ref") return { data: "ref-70", error: null };
        return { data: null, error: null };
      });
      return { client: withSpendRpc({ rpc, from }) as never };
    }

    it("blocks a complete, sesame-free label against a revision Jev already marked sesame " +
      "`listed`, instead of discarding that stored evidence for the fresh read", async () => {
        const db = fakeDbWithStoredEvidence([
          { food_key: "catalog_revision:70", allergen: "sesame", level: "listed", label_complete: false },
        ]);
        const labelCapture = vi.fn(async () => ({
          name: "Rice crackers", servingGrams: 30, per100g: {},
          // Complete and terminated; genuinely names no sesame. Only the stored row knows better.
          ingredientsText: "Rice flour, sunflower oil, salt.",
        }));
        const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/png" }));
        const out = await proposeDraft(db.client, db.client, "u1", {
          method: "label" as const, localDate: "2026-09-11", tz: "America/New_York", slot: "meal-1",
          mediaPath: "media/u1/44444444-4444-4444-8444-444444444444.jpg",
        }, { runCapture: labelCapture as never, searchFoods: searchOk as never,
          fetchOwnedObject: fetchOwned as never });
        expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
      });

    it("review r2 sol/BLOCK: the label card's own warning text agrees with the verdict it sits " +
      "next to, instead of reading the fresh OCR scan alone and saying 'No sesame listed' while " +
      "the item beside it is blocked for sesame", async () => {
        const db = fakeDbWithStoredEvidence([
          { food_key: "catalog_revision:70", allergen: "sesame", level: "listed", label_complete: false },
        ]);
        const labelCapture = vi.fn(async () => ({
          name: "Rice crackers", servingGrams: 30, per100g: {},
          ingredientsText: "Rice flour, sunflower oil, salt.",
        }));
        const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/png" }));
        const out = await proposeDraft(db.client, db.client, "u1", {
          method: "label" as const, localDate: "2026-09-11", tz: "America/New_York", slot: "meal-1",
          mediaPath: "media/u1/55555555-5555-4555-8555-555555555555.jpg",
        }, { runCapture: labelCapture as never, searchFoods: searchOk as never,
          fetchOwnedObject: fetchOwned as never });
        expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
        expect(out.labelFood?.allergenWarnings).toContainEqual(
          { allergen: "sesame", outcome: "present", text: "Contains sesame" });
      });
  });

  describe("finding: a label capture grounded to a catalog revision must carry the user's own " +
    "prior label checks too, not just the merged evidence", () => {
    /** Same per-table routing as `fakeDbWithStoredEvidence`, plus real `user_allergen_checks` rows. */
    function fakeDbWithChecks(checkRows: { food_key: string; allergen: string }[]) {
      const from = vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        for (const m of ["select", "neq", "gte", "order", "limit", "eq"]) chain[m] = vi.fn(self);
        // The paged ingredient read (t18) resolves at `.range()`: an empty, successful read.
        chain.range = vi.fn(() => settled({ data: [], error: null }));
        chain.in = table === "ai_calls" ? vi.fn(self) : vi.fn(() => settled(
          table === "user_allergen_checks" ? { data: checkRows, error: null }
            : table === "food_allergen_evidence" ? { data: [], error: null }
            : { data: [], error: null }));
        chain.maybeSingle = vi.fn().mockResolvedValue(
          table === "media_objects" ? { data: DEFAULT_MEDIA_OBJECT, error: null }
            : table === "constraint_profiles"
              ? { data: { ...RULES, avoid_allergens: ["mustard"] }, error: null }
              : { data: null, error: null });
        chain.insert = vi.fn(async () => ({ error: null }));
        return chain;
      });
      const rpc = vi.fn(async (name: string) => {
        if (name === "ai_calls_today") return { data: 0, error: null };
        if (name === "get_or_create_food_ref") return { data: "ref-70", error: null };
        return { data: null, error: null };
      });
      return { client: withSpendRpc({ rpc, from }) as never };
    }

    it("clears a checked, non-major named allergen (mustard) on a grounded label capture, " +
      "the same as markLabelChecked's own write already recorded", async () => {
      const db = fakeDbWithChecks([{ food_key: "catalog_revision:70", allergen: "mustard" }]);
      const labelCapture = vi.fn(async () => ({
        name: "Rice crackers", servingGrams: 30, per100g: {},
        // Names no mustard at all; only the prior check (readAllergenChecks) can clear it.
        ingredientsText: "Rice flour, sunflower oil, salt.",
      }));
      const fetchOwned = vi.fn(async () => ({ bytes: png(10, 10), mimeType: "image/png" }));
      const out = await proposeDraft(db.client, db.client, "u1", {
        method: "label" as const, localDate: "2026-09-11", tz: "America/New_York", slot: "meal-1",
        mediaPath: "media/u1/55555555-5555-4555-8555-555555555555.jpg",
      }, { runCapture: labelCapture as never, searchFoods: searchOk as never,
        fetchOwnedObject: fetchOwned as never });
      expect(out.items[0].policy).toMatchObject({ verdict: "allowed" });
    });
  });

  describe("finding: a photo/voice/text item grounded to a real catalog hit must read that " +
    "revision's own verbatim ingredient text, not just its structured allergen_tags", () => {
    function fakeDbWithCatalogIngredients(
      ingredientRows: { seq: number; raw_text: string | null; allergen_tags: string[] | null }[],
    ) {
      const from = vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        for (const m of ["select", "neq", "gte", "order", "limit"]) chain[m] = vi.fn(self);
        chain.eq = table === "catalog_ingredients"
          ? vi.fn(() => settled({ data: ingredientRows, error: null }))
          : vi.fn(self);
        chain.in = table === "ai_calls" ? vi.fn(self) : vi.fn(() => settled({ data: [], error: null }));
        chain.maybeSingle = vi.fn().mockResolvedValue(
          table === "constraint_profiles"
            ? { data: { ...RULES, avoid_allergens: ["mustard"] }, error: null }
            : { data: null, error: null });
        chain.insert = vi.fn(async () => ({ error: null }));
        return chain;
      });
      const rpc = vi.fn(async (name: string) => {
        if (name === "ai_calls_today") return { data: 0, error: null };
        if (name === "get_or_create_food_ref") return { data: "ref-70", error: null };
        return { data: null, error: null };
      });
      return { client: withSpendRpc({ rpc, from }) as never };
    }

    it("reads mustard as present from the revision's own printed text even though the " +
      "structured allergen_tags column was never populated for it", async () => {
        const db = fakeDbWithCatalogIngredients([
          // Named in the printed list; the structured `allergen_tags` column carries nothing —
          // mustard is not one of the nine FALCPA majors, so it is rarely pre-tagged.
          { seq: 1, raw_text: "Water, mustard seed, vinegar.", allergen_tags: null },
        ]);
        const out = await proposeDraft(db.client, db.client, "u1", REQ,
          { runCapture: captureOk as never, searchFoods: searchOk as never });
        expect(out.items[0].policy).toMatchObject({ verdict: "blocked", reason: "allergen:mustard" });
      });
  });

  describe("ORCHESTRATOR fix (round 7, item 6): the strict completeness predicate applies to the " +
    "grounded (non-label) capture path too", () => {
    function fakeDbWithCatalogIngredients(
      ingredientRows: { seq: number; name?: string; raw_text: string | null;
        allergen_tags: string[] | null }[],
      avoid: string[],
    ) {
      const from = vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        for (const m of ["select", "neq", "gte", "order", "limit"]) chain[m] = vi.fn(self);
        chain.eq = table === "catalog_ingredients"
          ? vi.fn(() => settled({ data: ingredientRows, error: null }))
          : vi.fn(self);
        chain.in = table === "ai_calls" ? vi.fn(self) : vi.fn(() => settled({ data: [], error: null }));
        chain.maybeSingle = vi.fn().mockResolvedValue(
          table === "constraint_profiles"
            ? { data: { ...RULES, avoid_allergens: avoid }, error: null }
            : { data: null, error: null });
        chain.insert = vi.fn(async () => ({ error: null }));
        return chain;
      });
      const rpc = vi.fn(async (name: string) => {
        if (name === "ai_calls_today") return { data: 0, error: null };
        if (name === "get_or_create_food_ref") return { data: "ref-70", error: null };
        return { data: null, error: null };
      });
      return { client: withSpendRpc({ rpc, from }) as never };
    }

    it("a complete, terminated seq-1 statement clears a major allergen on its own", async () => {
      const db = fakeDbWithCatalogIngredients([
        { seq: 1, name: "Water", raw_text: "Water, rice, salt.", allergen_tags: [] },
      ], ["dairy"]);
      const out = await proposeDraft(db.client, db.client, "u1", REQ,
        { runCapture: captureOk as never, searchFoods: searchOk as never });
      expect(out.items[0].policy).toMatchObject({ verdict: "allowed" });
    });

    it("a legacy row shape — a later row ALSO carrying its own raw_text, so seq 1's own text is " +
      "not genuinely the sole verbatim statement — must not read as complete just because seq 1 " +
      "happens to carry text: the account stays unverified rather than cleared", async () => {
      const db = fakeDbWithCatalogIngredients([
        { seq: 1, name: "Water", raw_text: "Water, rice, salt.", allergen_tags: [] },
        // Breaks the single-verbatim-statement shape completenessText requires: a genuine label
        // write never leaves a later row with its own raw_text too.
        { seq: 2, name: "rice", raw_text: "rice", allergen_tags: [] },
      ], ["dairy"]);
      const out = await proposeDraft(db.client, db.client, "u1", REQ,
        { runCapture: captureOk as never, searchFoods: searchOk as never });
      expect(out.items[0].policy).toMatchObject({ verdict: "unverified" });
    });
  });
});
