import { afterEach, describe, expect, it, vi } from "vitest";
import { AttestationRefused } from "@/lib/ai/attestation";
import { SchemaRejection } from "@/lib/ai/call";
import { confirmPantryPhoto, draftPantryPhoto, MAX_PANTRY_PHOTO_BYTES } from "@/lib/server/pantry-photo";
import { syntheticJpeg, syntheticJpegWithExif, syntheticPng } from "../helpers/synthetic-images";

const admin = {} as never;
const PATH = "media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";

afterEach(() => { vi.unstubAllEnvs(); });

describe("draftPantryPhoto", () => {
  it("writes nothing and returns the kind:ingredients names, cleaned (acceptance 1)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockResolvedValue({ kind: "ingredients", title: null,
      ingredients: ["Eggs", "eggs", " Spinach "] });
    const draft = await draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpeg(), mimeType: "image/jpeg" }),
    });
    expect(draft).toEqual({ items: ["Eggs", "Spinach"] });
  });

  it("keeps only kind:ingredients names — a forced read that still comes back as something else yields none (acceptance 7)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockResolvedValue({ kind: "unknown", title: null, ingredients: ["rice"] });
    const draft = await draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpeg(), mimeType: "image/jpeg" }),
    });
    expect(draft).toEqual({ items: [] });
  });

  it("asks only the photoToIdeas pin, with the fixed prompt, no slot calories and no account data (acceptance 6)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockResolvedValue({ kind: "ingredients", title: null, ingredients: [] });
    const bytes = syntheticJpeg();
    await draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes, mimeType: "image/jpeg" }),
    });
    const call = generate.mock.calls[0][0];
    expect(call.payload.purpose).toBe("photoToIdeas");
    // Only the fixed prompt (the forced "ingredients" read line) and the image — nothing a kcal
    // target, a profile, a rule or an account field could have added.
    expect(call.payload.text).toContain("wants to cook from this photo");
    // No slot-calorie injection (the targetKcal line plan-inspire.ts adds) and no account id.
    expect(call.payload.text).not.toMatch(/meant to be about \d+ kcal/i);
    expect(call.payload.text).not.toContain("u1");
    expect(Object.keys(call.payload)).toEqual(expect.arrayContaining(["purpose", "text", "imageDataUrl"]));
    expect(call.payload.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("records only the stripped image's byte size (W155)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const generate = vi.fn().mockResolvedValue({ kind: "ingredients", title: null, ingredients: [] });
    await draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpegWithExif(), mimeType: "image/jpeg" }),
    });
    const sent = Buffer.from(generate.mock.calls[0][0].payload.imageDataUrl.split(",")[1], "base64").byteLength;
    const lines = info.mock.calls.filter((c) => c[0] === "[media-telemetry]").map((c) => c[1]);
    info.mockRestore();
    expect(lines).toEqual([{ purpose: "pantryPhoto", image_bytes: sent }]);
  });

  it("strips EXIF/GPS metadata server-side before the payload is built (acceptance 5)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockResolvedValue({ kind: "ingredients", title: null, ingredients: [] });
    await draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpegWithExif(), mimeType: "image/jpeg" }),
    });
    const base64 = generate.mock.calls[0][0].payload.imageDataUrl.split(",")[1];
    const text = Buffer.from(base64, "base64").toString("latin1");
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS_LAT_LONG");
  });

  it("refuses an unparseable file before any provider call (acceptance 5)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn();
    await expect(draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), mimeType: "image/jpeg" }),
    })).rejects.toMatchObject({ status: 422, code: "unreadable_photo" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a non-image object before any provider call", async () => {
    const generate = vi.fn();
    await expect(draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpeg(), mimeType: "audio/mp4" }),
    })).rejects.toMatchObject({ status: 415 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses an oversized photo before any provider call", async () => {
    const generate = vi.fn();
    const big = new Uint8Array(MAX_PANTRY_PHOTO_BYTES + 1);
    big.set(syntheticJpeg());
    await expect(draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: big, mimeType: "image/jpeg" }),
    })).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("makes 0 Gemini calls and answers an error when OpenRouter is unavailable (acceptance 7/boundary)", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    const generate = vi.fn();
    await expect(draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticPng(), mimeType: "image/png" }),
    })).rejects.toMatchObject({ status: 503 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("never falls back to Gemini on any provider failure — the route has no fallback leg at all", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockRejectedValue(new AttestationRefused());
    await expect(draftPantryPhoto(admin, "u1", PATH, {
      generate, fetchObject: async () => ({ bytes: syntheticJpeg(), mimeType: "image/jpeg" }),
    })).rejects.toMatchObject({ status: 503 });
    const schemaBad = vi.fn().mockRejectedValue(new SchemaRejection("bad reply"));
    await expect(draftPantryPhoto(admin, "u2", PATH, {
      generate: schemaBad, fetchObject: async () => ({ bytes: syntheticJpeg(), mimeType: "image/jpeg" }),
    })).rejects.toMatchObject({ status: 422, code: "schema_invalid" });
  });
});

describe("confirmPantryPhoto", () => {
  it("writes one row per confirmed item with source: 'photo'; null grams are allowed (acceptance 2)", async () => {
    const inserted: { table: string; row: Record<string, unknown> }[] = [];
    const client = {
      from: (table: string) => ({
        select: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          return { select: () => ({ single: async () => ({
            data: { id: `row-${inserted.length}`, user_id: row.user_id, name: row.name,
              identity: row.identity, confirmed_grams: row.confirmed_grams, source: row.source,
              confirmed_at: "2026-10-07T00:00:00Z", rev: 1 }, error: null }) }) };
        },
      }),
    } as never;
    const { written, failed } = await confirmPantryPhoto(client, "u1",
      [{ name: "Eggs", grams: null }, { name: "Milk", grams: 500 }], "11111111-1111-4111-8111-111111111111");
    expect(written).toHaveLength(2);
    expect(failed).toEqual([]);
    expect(written.map((item) => item.source)).toEqual(["photo", "photo"]);
    expect(written.map((item) => item.confirmedGrams)).toEqual([null, 500]);
    expect(inserted.every((call) => call.row.source === "photo")).toBe(true);
    // Sol review BLOCK: shopping_pantry.request_id is a `uuid` column — a literal
    // `${requestId}:${index}` is not a valid uuid and Postgres would refuse every insert. Each
    // item must get its own well-formed, distinct UUID.
    const requestIds = inserted.map((call) => call.row.request_id as string);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const id of requestIds) expect(id).toMatch(UUID);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  it("derives the same per-item request id on an exact retry, so a resend no-ops idempotently", async () => {
    const seen: string[] = [];
    const client = { from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      insert: (row: Record<string, unknown>) => {
        seen.push(row.request_id as string);
        return { select: () => ({ single: async () => ({ data: { id: "r1", user_id: row.user_id,
          name: row.name, identity: row.identity, confirmed_grams: row.confirmed_grams,
          source: row.source, confirmed_at: "2026-10-07T00:00:00Z", rev: 1 }, error: null }) }) };
      },
    }) } as never;
    await confirmPantryPhoto(client, "u1", [{ name: "Eggs", grams: null }], "22222222-2222-4222-8222-222222222222");
    await confirmPantryPhoto(client, "u1", [{ name: "Eggs", grams: null }], "22222222-2222-4222-8222-222222222222");
    expect(seen[0]).toBe(seen[1]);
  });

  it("keeps writing the rest of the batch when one item collides, instead of discarding what already landed", async () => {
    const inserted: Record<string, unknown>[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          if (row.name === "Milk") {
            return { select: () => ({ single: async () => ({
              data: null, error: { code: "23505", message: "duplicate" } }) }) };
          }
          return { select: () => ({ single: async () => ({
            data: { id: `row-${inserted.length}`, user_id: row.user_id, name: row.name,
              identity: row.identity, confirmed_grams: row.confirmed_grams, source: row.source,
              confirmed_at: "2026-10-07T00:00:00Z", rev: 1 }, error: null }) }) };
        },
      }),
    } as never;
    const { written, failed } = await confirmPantryPhoto(client, "u1",
      [{ name: "Eggs", grams: null }, { name: "Milk", grams: 500 }, { name: "Spinach", grams: 200 }],
      "11111111-1111-4111-8111-111111111111");
    // Eggs and Spinach still land even though Milk (the middle item) collided — a mid-batch
    // failure must not silently discard items the loop had already (or would still) write.
    expect(written.map((item) => item.name)).toEqual(["Eggs", "Spinach"]);
    expect(failed).toEqual([{ name: "Milk", status: 409, code: "pantry_identity_exists",
      message: "This food is already in your pantry. Reload and edit its confirmed amount." }]);
  });
});
