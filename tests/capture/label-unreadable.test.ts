import { withSpendRpc } from "@/tests/ai/spend-admin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCapture } from "@/lib/ai/capture";
import { PROMPTS } from "@/lib/ai/prompts";
import { labelNutrientsSchema } from "@/lib/ai/schemas";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";
import { proposeDraft } from "@/lib/server/capture";

/**
 * 2026-10-03: a blank image read as a label came back as an invented "Organic Whole Milk". The
 * label schema now carries `labelReadable`, the prompt requires `false` when no panel is clearly
 * visible, and proposeDraft turns that into the existing 422 — on either provider, with no draft.
 */

const NULLS = Object.fromEntries(NUTRIENT_CODES.map((c) => [c, null]));
const UNREADABLE = { labelReadable: false, name: "none", servingGrams: 0, per100g: NULLS };
const READABLE = {
  labelReadable: true, name: "Pear pouch", servingGrams: 90,
  per100g: { ...NULLS, energy_kcal: 60 }, ingredientsText: "pear",
};
const REQ = {
  method: "label" as const, localDate: "2026-10-03", tz: "America/New_York",
  mediaPath: "media/u1/55555555-5555-4555-8555-555555555555.png",
};

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function fakeDb() {
  const inserts: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string) => ({
    data: name === "ai_calls_today" ? 0 : name === "get_or_create_food_ref" ? "ref-1" : null, error: null,
  }));
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "order", "limit"]) chain[m] = vi.fn(() => chain);
    chain.in = table === "ai_calls" ? vi.fn(() => chain) : vi.fn(async () => ({ data: [], error: null }));
    chain.maybeSingle = vi.fn(async () => (table === "media_objects"
      ? { data: { path: REQ.mediaPath, user_id: "u1", deleted_at: null }, error: null }
      : { data: null, error: null }));
    chain.insert = vi.fn(async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; });
    return chain;
  });
  return { client: withSpendRpc({ rpc, from }) as never, inserts };
}

const fetchOwnedObject = vi.fn(async () => ({ bytes: png(64, 64), mimeType: "image/png" }));
const searchFoods = vi.fn(async () => ({ hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v1" }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); searchFoods.mockClear(); });

describe("an unreadable label", () => {
  it("the schema requires labelReadable and the prompt asks for false with no panel", () => {
    const { labelReadable: _omit, ...rest } = READABLE;
    expect(labelNutrientsSchema.safeParse(rest).success).toBe(false);
    expect(labelNutrientsSchema.safeParse(UNREADABLE).success).toBe(true);
    expect(PROMPTS.labelToNutrients.system).toMatch(/labelReadable to false/);
    expect(PROMPTS.labelToNutrients.system).toMatch(/Never invent a product/);
  });

  it("Gemini answering labelReadable false is a 422 with no draft and no log line", async () => {
    vi.stubEnv("CAPTURE_METHODS", "label");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const db = fakeDb();
    await expect(proposeDraft(db.client, db.client, "u1", REQ, {
      fetchOwnedObject: fetchOwnedObject as never, searchFoods: searchFoods as never,
      runCapture: (payload, ctx) => runCapture(payload, ctx, {
        sleep: async () => {},
        callGemini: async () => ({ text: JSON.stringify(UNREADABLE), inputTokens: 1, outputTokens: 1 }),
      }),
    })).rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    expect(searchFoods).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("OpenRouter answering labelReadable false is the same 422, without a Gemini fallback", async () => {
    vi.stubEnv("CAPTURE_METHODS", "label");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const callGemini = vi.fn();
    const send = vi.fn(async () => ({ text: JSON.stringify(UNREADABLE), inputTokens: 1, outputTokens: 1, costUsd: 0 }));
    const db = fakeDb();
    await expect(proposeDraft(db.client, db.client, "u1", REQ, {
      fetchOwnedObject: fetchOwnedObject as never, searchFoods: searchFoods as never,
      runCapture: (payload, ctx) => runCapture(payload, ctx, { callGemini, openRouterDeps: { send } }),
    })).rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(callGemini).not.toHaveBeenCalled();
    expect(searchFoods).not.toHaveBeenCalled();
  });

  it("a readable label still parses into a draft", async () => {
    vi.stubEnv("CAPTURE_METHODS", "label");
    const db = fakeDb();
    const out = await proposeDraft(db.client, db.client, "u1", REQ, {
      fetchOwnedObject: fetchOwnedObject as never, searchFoods: searchFoods as never,
      runCapture: (payload, ctx) => runCapture(payload, ctx, {
        sleep: async () => {},
        callGemini: async () => ({ text: JSON.stringify(READABLE), inputTokens: 1, outputTokens: 1 }),
      }),
    });
    expect(out.labelFood?.name).toBe("Pear pouch");
    expect(out.items).toHaveLength(1);
  });
});
