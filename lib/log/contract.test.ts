import { describe, expect, it } from "vitest";
import { issuesFrom, localDateFor, logCommitRequestSchema, opIdFor } from "./contract";

const ITEM = { id: "3f1c5a2e-9b7d-4a61-8c2f-0d5e6a7b8c90", seq: 1,
  food_ref_id: "7a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071", qty: 1, unit: "g", grams: 140 };

function body(over: Record<string, unknown> = {}) {
  return { entry_id: "11111111-2222-4333-8444-555555555555",
    eaten_at: "2026-09-18T02:30:00.000Z", tz: "America/Los_Angeles",
    local_date: "2026-09-17", slot: "meal-3", method: "search", items: [ITEM], ...over };
}

describe("logCommitRequestSchema", () => {
  it("accepts a well-formed create", () => {
    expect(logCommitRequestSchema.safeParse(body()).success).toBe(true);
  });

  it("rejects negative grams at the item path", () => {
    const parsed = logCommitRequestSchema.safeParse(
      body({ items: [{ ...ITEM, grams: -1 }] }));
    expect(parsed.success).toBe(false);
    expect(issuesFrom(parsed.error!)).toContainEqual(
      { path: "items.0.grams", message: expect.stringContaining("greater than") });
  });

  it("rejects a zero-gram item — a real food must contribute something", () => {
    const parsed = logCommitRequestSchema.safeParse(
      body({ items: [{ ...ITEM, qty: 0, grams: 0 }] }));
    expect(parsed.success).toBe(false);
    expect(issuesFrom(parsed.error!)).toContainEqual(
      { path: "items.0.grams", message: expect.stringContaining("greater than") });
  });

  it("rejects a duplicate seq", () => {
    const parsed = logCommitRequestSchema.safeParse(body({
      items: [ITEM, { ...ITEM, id: "9f1c5a2e-9b7d-4a61-8c2f-0d5e6a7b8c91" }] }));
    expect(parsed.success).toBe(false);
    expect(issuesFrom(parsed.error!)).toContainEqual(
      { path: "items", message: "seq must be unique within an entry" });
  });

  it("rejects a local_date that disagrees with eaten_at in tz", () => {
    const parsed = logCommitRequestSchema.safeParse(body({ local_date: "2026-09-18" }));
    expect(parsed.success).toBe(false);
    expect(issuesFrom(parsed.error!)).toContainEqual(
      { path: "local_date", message: "local_date does not match eaten_at in tz" });
  });

  it("requires draft_id for voice, label and photo and not for search", () => {
    expect(logCommitRequestSchema.safeParse(body({ method: "voice" })).success).toBe(false);
    expect(logCommitRequestSchema.safeParse(
      body({ method: "voice", draft_id: "22222222-3333-4444-8555-666666666666" }))
      .success).toBe(true);
    expect(logCommitRequestSchema.safeParse(body({ method: "search" })).success).toBe(true);
  });

  it("allows save_label_as_food only with method label", () => {
    const parsed = logCommitRequestSchema.safeParse(
      body({ method: "search", save_label_as_food: true }));
    expect(issuesFrom(parsed.error!)).toContainEqual(
      { path: "save_label_as_food", message: "save_label_as_food needs method 'label'" });
  });

  it("rejects an empty item list and one over thirty items", () => {
    expect(logCommitRequestSchema.safeParse(body({ items: [] })).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => ({ ...ITEM, seq: i + 1,
      id: `1111111${i % 10}-2222-4333-8444-55555555555${i % 10}` }));
    expect(logCommitRequestSchema.safeParse(body({ items: many })).success).toBe(false);
  });

  it("rejects an unknown slot", () => {
    expect(logCommitRequestSchema.safeParse(body({ slot: "brunch" })).success).toBe(false);
  });

  it("accepts a confidence within 0..1 and rejects one outside it", () => {
    expect(logCommitRequestSchema.safeParse(
      body({ items: [{ ...ITEM, confidence: 0.5 }] })).success).toBe(true);
    expect(logCommitRequestSchema.safeParse(body()).success).toBe(true); // still optional
    const parsed = logCommitRequestSchema.safeParse(
      body({ items: [{ ...ITEM, confidence: 1.5 }] }));
    expect(parsed.success).toBe(false);
    expect(issuesFrom(parsed.error!)).toContainEqual(
      expect.objectContaining({ path: "items.0.confidence" }));
  });
});

describe("localDateFor", () => {
  it("puts a 23:30 Los Angeles meal on the day she ate it", () => {
    expect(localDateFor("2026-09-18T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-09-17");
  });

  it("survives the DST change day", () => {
    expect(localDateFor("2026-11-01T08:30:00.000Z", "America/Los_Angeles")).toBe("2026-11-01");
  });

  it("is null for an unknown zone", () => {
    expect(localDateFor("2026-09-18T06:30:00.000Z", "Mars/Olympus")).toBeNull();
  });
});

describe("opIdFor", () => {
  it("is stable for the same entry and base_rev, and a valid v5 uuid", () => {
    const a = opIdFor("11111111-2222-4333-8444-555555555555", undefined);
    expect(a).toBe(opIdFor("11111111-2222-4333-8444-555555555555", undefined));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs per base_rev, so an edit is a new op and a replay is the same op", () => {
    expect(opIdFor("11111111-2222-4333-8444-555555555555", 1))
      .not.toBe(opIdFor("11111111-2222-4333-8444-555555555555", 2));
    expect(opIdFor("11111111-2222-4333-8444-555555555555", 1))
      .toBe(opIdFor("11111111-2222-4333-8444-555555555555", 1));
  });
});
