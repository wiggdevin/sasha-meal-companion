/**
 * 2026-10-02 DeepSeek audit, round 5 (MED): the circuit breaker now opens per model, so an open
 * circuit on the coach's pinned model leaves its fallback model reachable. The coach's gates read
 * only "capacity", and "circuit open …" was not one, so the turn failed with a healthy model left.
 */
import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "@/lib/ai/call";
import { isCapacityFailure, isPermissionDeniedFailure, worthAnotherModel } from "@/lib/ai/failures";

const open = () => new Error("circuit open for google gemini-3.6-flash: 5 failures in the last 10 minutes");

describe("an open circuit", () => {
  it("is a capacity failure, worth another model", () => {
    expect(isCapacityFailure(open())).toBe(true);
    expect(worthAnotherModel(open())).toBe(true);
  });

  it("does not make a schema refusal or a key quota worth another model", () => {
    expect(worthAnotherModel(new Error("schema_invalid: reply did not match"))).toBe(false);
    expect(worthAnotherModel(Object.assign(new Error("quota"), { status: 429 }))).toBe(false);
  });
});

/** 2026-10-06 (Gemini project denial, #gemini-fallback). */
describe("a 403 PERMISSION_DENIED", () => {
  const denied = () => new ProviderHttpError(403,
    "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");

  it("is recognised whatever wording the provider wraps it in", () => {
    expect(isPermissionDeniedFailure(denied())).toBe(true);
    expect(isPermissionDeniedFailure(new ProviderHttpError(403, "openrouter 403: denied access to this model")))
      .toBe(true);
  });

  it("is never worth retrying on the SAME key's other model (every model on it is blocked)", () => {
    expect(worthAnotherModel(denied())).toBe(false);
  });

  it("is not a capacity failure — a 403 does not mean the model is merely overloaded", () => {
    expect(isCapacityFailure(denied())).toBe(false);
  });

  it("a 403 for an unrelated reason (not PERMISSION_DENIED) is not this failure", () => {
    expect(isPermissionDeniedFailure(new ProviderHttpError(403, "media_not_owned: that file is not yours")))
      .toBe(false);
    expect(isPermissionDeniedFailure(Object.assign(new Error("denied access"), { status: 404 }))).toBe(false);
    expect(isPermissionDeniedFailure("not an error at all")).toBe(false);
  });
});

