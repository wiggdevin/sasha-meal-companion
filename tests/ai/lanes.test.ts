/**
 * Phase 13 §3 (slice 1): lib/ai/lanes.ts is the one pin table, and absorbing the pins changed no
 * behaviour — every pin a runtime path read before still resolves to the same literal.
 */
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MODELS } from "@/lib/ai/adapter";
import { LANES, OPENROUTER_PINS, laneCleared } from "@/lib/ai/lanes";
import {
  captureOpenRouterModel, captureVoiceOpenRouterModel, coachOpenRouterFallbackModel,
  COACH_FALLBACK_MODEL_ID, COACH_PROVIDER, COACH_MODEL_ID, GEMINI_COACH, GEMINI_FLASH, JEV_MODEL,
  planDocumentModel, planPhotoModel, PRICE_PER_MILLION_TOKENS,
} from "@/lib/ai/models";

function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`)
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.(ts|tsx|js|mjs)$/.test(f));
}

function stringLiterals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return literals;
}

describe("the lane table (Phase 13 §3)", () => {
  it("keeps every existing pin exactly where it was (no behaviour change)", () => {
    expect(GEMINI_FLASH).toBe("gemini-3.8-flash");
    expect(GEMINI_COACH).toBe("gemini-3.6-flash");
    expect(COACH_MODEL_ID).toBe(COACH_PROVIDER === "openrouter"
      ? OPENROUTER_PINS.coach : "gemini-3.6-flash");
    expect(COACH_FALLBACK_MODEL_ID).toBe("gemini-3.8-flash");
    expect(JEV_MODEL).toBe("jev-latest");
    expect(MODELS).toEqual({
      textToItems: "gemini-3.8-flash", voiceToItems: "gemini-3.8-flash",
      labelToNutrients: "gemini-3.8-flash", photoToItems: "gemini-3.8-flash",
      coach: "gemini-3.6-flash", weeklyReview: "gemini-3.6-flash",
      "coach-transcribe": "gemini-3.8-flash", lookup: "gemini-3.8-flash",
      "photoToIdeas-gemini": "gemini-3.8-flash", "documentToPlan-gemini": "gemini-3.8-flash",
      "onboarding-extract": "gemini-3.8-flash",
    });
  });

  it("names the spec §3 lanes with their provider, pin, fallback and budget", () => {
    expect(Object.keys(LANES)).toEqual(
      ["route", "mechanical", "converse", "capture", "plan", "lookup", "judge"]);
    expect(LANES.converse).toMatchObject({ provider: "google", model: GEMINI_COACH,
      fallback: GEMINI_FLASH, wired: true });
    expect(LANES.capture).toMatchObject({ provider: "google", model: GEMINI_FLASH, wired: true });
    expect(LANES.plan).toMatchObject({ provider: "openrouter", fallback: GEMINI_FLASH, wired: true });
    expect(LANES.lookup).toMatchObject({ provider: "google", model: GEMINI_FLASH,
      budgetMs: 8_000, wired: true });
    expect(LANES.route).toMatchObject({ provider: "typesafe", model: "jev-latest", budgetMs: 3_000 });
    expect(LANES.judge).toMatchObject({ provider: "typesafe", model: "jev-latest", budgetMs: 3_000 });
    expect(LANES.mechanical).toMatchObject({ provider: null, model: null });
  });

  it("keeps both Plan primary ids pinned to LANES despite retired env overrides", () => {
    vi.stubEnv("PLAN_PHOTO_MODEL_ID", "unreviewed-photo");
    vi.stubEnv("PLAN_DOCUMENT_MODEL_ID", "unreviewed-document");
    try {
      expect(planPhotoModel()).toBe(LANES.plan.model);
      expect(planDocumentModel()).toBe(LANES.plan.model);
      expect(OPENROUTER_PINS.planPhoto).toBe(LANES.plan.model);
      expect(OPENROUTER_PINS.planDocument).toBe(LANES.plan.model);
    } finally { vi.unstubAllEnvs(); }
  });

  it("gives each lane exactly its provider's cleared classes", () => {
    expect(laneCleared("converse")).toEqual(["D0", "D1", "D2"]);
    expect(laneCleared("judge")).toEqual(["D0", "D1"]);
    expect(laneCleared("mechanical")).toEqual([]);
  });

  it("prices every Gemini pin, so the spend cap never meets an unpriced model", () => {
    const priced = Object.values(LANES).flatMap((lane) =>
      lane.provider === "google" ? [lane.model] : []);
    expect(priced.filter((model) => !PRICE_PER_MILLION_TOKENS[model])).toEqual([]);
  });

  it("uses literal ids with no alias the app does not control, other than Jev's documented one", () => {
    for (const lane of Object.values(LANES)) {
      if (lane.model === null || lane.provider === "typesafe") continue;
      expect(lane.model).not.toMatch(/latest|\$\{/);
    }
  });

  it("holds every model id literal in the lane table", () => {
    const MODEL_ID = /["'`](?:gemini-\d[\w.-]*|deepseek-[\w.-]+|jev-(?:latest|\d[\w.-]*)|(?:anthropic|google|openai)\/[\w.-]+)["'`]/;
    const VENDOR_MODEL = /^[a-z][\w.-]*\/[a-z0-9][\w.-]*$/i;
    expect(["meta-llama/llama-3", "mistralai/mistral-small", "x-ai/grok-4"]
      .every((slug) => VENDOR_MODEL.test(slug))).toBe(true);
    // These are protocol, path, time-zone and MIME strings, not provider/model slugs.
    const nonModels = new Set([
      "America/Denver", "America/Los_Angeles", "America/New_York", "n/a",
      "docs/evals", "docs/features.md", "supabase/migrations", "tools/call",
      "application/json", "application/pdf", "application/x-www-form-urlencoded",
      "audio/aac", "audio/mp4", "audio/mpeg", "audio/wav",
      "image/gif", "image/jpeg", "image/png", "text/calendar", "text/csv", "text/plain",
    ]);
    // facet-thresholds.ts is generated: it records the Jev version the thresholds were calibrated
    // against, which is evidence, not a pin.
    const allowed = ["lib/ai/lanes.ts", "lib/ai/models.ts", "lib/foods/facet-thresholds.ts"];
    const modelOffenders = ["app", "lib", "components"].flatMap(sourceFiles)
      .filter((file) => !allowed.includes(file))
      .filter((file) => MODEL_ID.test(code(file)));
    const slugOffenders = ["app", "lib", "components", "scripts"].flatMap(sourceFiles)
      .filter((file) => file !== "lib/ai/lanes.ts")
      .filter((file) => stringLiterals(file).some((literal) => VENDOR_MODEL.test(literal)
        && !nonModels.has(literal)));
    expect(modelOffenders).toEqual([]);
    expect(slugOffenders).toEqual([]);
    // models.ts holds only the price table's keys: no pin of its own.
    expect(code("lib/ai/models.ts").replace(/PRICE_PER_MILLION_TOKENS[\s\S]*?\n\};/, ""))
      .not.toMatch(MODEL_ID);
  });

  it("pins the production OpenRouter ids in the one pin table", () => {
    expect(OPENROUTER_PINS).toEqual({
      coach: "google/gemini-2.5-flash",
      coachFallback: "google/gemini-3-flash-preview",
      planPhoto: "google/gemini-3-flash-preview",
      planDocument: "google/gemini-3-flash-preview",
      capture: "google/gemini-2.5-flash",
      onboardingExtract: "google/gemini-2.5-flash",
      // 2026-10-06 (Gemini project denial): voice capture and the coach's transcribe fallback
      // reuse the SAME already-vetted slug as `capture` above, not a separately-pinned model.
      captureVoice: "google/gemini-2.5-flash",
    });
    expect(coachOpenRouterFallbackModel()).toBe("google/gemini-3-flash-preview");
    expect(planPhotoModel()).toBe("google/gemini-3-flash-preview");
    expect(planDocumentModel()).toBe("google/gemini-3-flash-preview");
    expect(captureOpenRouterModel()).toBe("google/gemini-2.5-flash");
    expect(captureVoiceOpenRouterModel()).toBe("google/gemini-2.5-flash");
  });

  it("reads none of the retired model-id env vars in runtime or scripts", () => {
    const names = "COACH_MODEL_ID|COACH_OPENROUTER_FALLBACK_MODEL|PLAN_PHOTO_MODEL_ID|PLAN_DOCUMENT_MODEL_ID|CAPTURE_OPENROUTER_MODEL";
    const retired = new RegExp(`process\\s*\\.\\s*env\\s*(?:\\.\\s*(?:${names})\\b|\\[\\s*["'\\x60](?:${names})["'\\x60]\\s*\\])`);
    expect(retired.test("process.env['COACH_MODEL_ID']")).toBe(true);
    expect(retired.test('process.env["PLAN_PHOTO_MODEL_ID"]')).toBe(true);
    const offenders = ["app", "lib", "components", "scripts"].flatMap(sourceFiles)
      .filter((file) => retired.test(code(file)));
    expect(offenders).toEqual([]);
  });
});
