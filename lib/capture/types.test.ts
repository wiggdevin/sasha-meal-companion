import { describe, expect, it } from "vitest";
import { proposeRequestSchema, signRequestSchema } from "./types";

const MEDIA_PATH = "media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg";

describe("signRequestSchema", () => {
  it("parses a valid image sign request", () => {
    const result = signRequestSchema.safeParse({
      kind: "image",
      contentType: "image/jpeg",
      bytes: 1024,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid audio sign request", () => {
    const result = signRequestSchema.safeParse({
      kind: "audio",
      contentType: "audio/aac",
      bytes: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown contentType", () => {
    const result = signRequestSchema.safeParse({
      kind: "image",
      contentType: "image/gif",
      bytes: 1024,
    });
    expect(result.success).toBe(false);
  });

  it("rejects bytes over the 8 MB cap", () => {
    const result = signRequestSchema.safeParse({
      kind: "image",
      contentType: "image/jpeg",
      bytes: 8388609,
    });
    expect(result.success).toBe(false);
  });

  it("rejects bytes of 0", () => {
    const result = signRequestSchema.safeParse({
      kind: "image",
      contentType: "image/jpeg",
      bytes: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("proposeRequestSchema", () => {
  it("parses a valid text-method body", () => {
    const result = proposeRequestSchema.safeParse({
      method: "text",
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "meal-1",
      text: "a bowl of rice and chicken",
    });
    expect(result.success).toBe(true);
  });

  it.each(["voice", "label", "photo"] as const)("parses a valid %s-method body", (method) => {
    const result = proposeRequestSchema.safeParse({
      method,
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "meal-1",
      mediaPath: MEDIA_PATH,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a text method carrying mediaPath instead of text", () => {
    const result = proposeRequestSchema.safeParse({
      method: "text",
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "meal-1",
      mediaPath: MEDIA_PATH,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a voice method carrying text instead of mediaPath", () => {
    const result = proposeRequestSchema.safeParse({
      method: "voice",
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "meal-1",
      text: "a bowl of rice and chicken",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mediaPath with a traversal segment", () => {
    const result = proposeRequestSchema.safeParse({
      method: "photo",
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "meal-1",
      mediaPath: "media/../11111111-1111-1111-1111-111111111111.jpg",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown slot", () => {
    const result = proposeRequestSchema.safeParse({
      method: "text",
      localDate: "2026-09-11",
      tz: "America/New_York",
      slot: "snack-99",
      text: "a bowl of rice",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed localDate", () => {
    const result = proposeRequestSchema.safeParse({
      method: "text",
      localDate: "09/11/2026",
      tz: "America/New_York",
      slot: "meal-1",
      text: "a bowl of rice",
    });
    expect(result.success).toBe(false);
  });
});
