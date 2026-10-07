// lib/ai/gemini-config.test.ts
/**
 * 2026-09-14. Devin: the coach "takes way too long", and its answers sometimes carried the model's
 * own working — verbatim, to her: "Wait, no control tokens allowed anywhere at any places in JSON
 * string!"
 *
 * gemini-3.6-flash thinks by default, and nothing here turned it off. Measured against the live
 * API on one trivial prompt, same schema, same temperature:
 *
 *   default   2375 ms, 206 thought tokens      MINIMAL   1134 ms, 0 thought tokens
 *   default   3191 ms, 453 thought tokens      MINIMAL   1434 ms, 0 thought tokens
 *
 * Every coach turn makes three to seven of these calls on a 1,200-2,000 token prompt, where the
 * thinking is far larger than it is here — which is how single calls reached 20-38 s.
 *
 * `thinkingBudget` is NOT the knob: the SDK says it "will no longer be supported and will result
 * in a user error" from Gemini 3.5 on. `thinkingLevel` is.
 */
import { describe, expect, it } from "vitest";
import { ThinkingLevel } from "@google/genai";
import { geminiConfig } from "@/lib/ai/gemini-config";

const schema = { type: "object" } as Record<string, unknown>;

describe("geminiConfig", () => {
  it("turns thinking down by default — every call this app makes is a short structured reply", () => {
    expect(geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema }).thinkingConfig)
      .toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });

  it("uses LOW for the pinned capture model, which rejects MINIMAL", () => {
    expect(geminiConfig({ model: "gemini-3.8-flash", jsonSchema: schema }).thinkingConfig)
      .toEqual({ thinkingLevel: ThinkingLevel.LOW });
  });

  it("honors an explicit thinking override on the capture model", () => {
    expect(geminiConfig({ model: "gemini-3.8-flash", jsonSchema: schema,
      thinkingLevel: ThinkingLevel.MEDIUM }).thinkingConfig)
      .toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
  });

  it("never sends thinkingBudget, which errors on this model generation", () => {
    expect(JSON.stringify(geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema }))).not.toContain("thinkingBudget");
  });

  it("lets a caller ask for more thinking when a task actually needs it", () => {
    expect(geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema, thinkingLevel: ThinkingLevel.MEDIUM }).thinkingConfig)
      .toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
  });

  it("keeps the JSON contract the schema parse depends on", () => {
    const config = geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema });
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseSchema).toBe(schema);
  });

  it("defaults temperature to 0 and passes a caller's through", () => {
    expect(geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema }).temperature).toBe(0);
    expect(geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema, temperature: 0.3 }).temperature).toBe(0.3);
  });

  it("omits the optional keys entirely when the caller gave none", () => {
    const config = geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema });
    expect("abortSignal" in config).toBe(false);
    expect("maxOutputTokens" in config).toBe(false);
  });

  it("carries the abort signal and token cap when given", () => {
    const signal = new AbortController().signal;
    const config = geminiConfig({ model: "gemini-3.6-flash", jsonSchema: schema, signal, maxOutputTokens: 1200 });
    expect(config.abortSignal).toBe(signal);
    expect(config.maxOutputTokens).toBe(1200);
  });
});
