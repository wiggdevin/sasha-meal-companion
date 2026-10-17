/**
 * W068: a Gemini error keeps its status and fixed codes only, never the provider's own words, which
 * can echo the user's content into `ai_calls.error` and the logs. The codes still carry what
 * lib/ai/failures.ts reads to route a failure.
 */
import { describe, expect, it } from "vitest";
import { geminiHttpError } from "@/lib/ai/adapter";
import { isCapacityFailure, isPermissionDeniedFailure, worthAnotherModel } from "@/lib/ai/failures";

const SECRET = "I had salmon at Mom's";

describe("geminiHttpError", () => {
  it("drops the provider text and keeps the status", () => {
    const e = geminiHttpError({ status: 400, message: `bad request near "${SECRET}"` });
    expect(e?.message).toBe("gemini 400");
    expect(e?.status).toBe(400);
  });

  it("keeps a project denial recognisable", () => {
    const e = geminiHttpError({ status: 403,
      message: `PERMISSION_DENIED: Your project has been denied access. ${SECRET}` });
    expect(e?.message).toBe("gemini 403: PERMISSION_DENIED");
    expect(isPermissionDeniedFailure(e)).toBe(true);
    expect(worthAnotherModel(e)).toBe(false);
  });

  it("keeps an overload a capacity failure worth another model", () => {
    const e = geminiHttpError({ status: 503, message: `The model is overloaded. ${SECRET}` });
    expect(e?.message).toBe("gemini 503: UNAVAILABLE");
    expect(isCapacityFailure(e)).toBe(true);
    expect(worthAnotherModel(e)).toBe(true);
  });

  it("keeps a schema complaint and a quota from looking worth another model", () => {
    const schema = geminiHttpError({ status: 503, message: `response_schema is invalid: ${SECRET}` });
    expect(schema?.message).toBe("gemini 503: schema");
    expect(worthAnotherModel(schema)).toBe(false);
    const quota = geminiHttpError({ status: 400, message: "RESOURCE_EXHAUSTED: quota exceeded" });
    expect(quota?.message).toBe("gemini 400: RESOURCE_EXHAUSTED");
    expect(worthAnotherModel(quota)).toBe(false);
  });

  it("is null for an error with no status", () => {
    expect(geminiHttpError(new Error(SECRET))).toBeNull();
  });
});
