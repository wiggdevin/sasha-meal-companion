/**
 * Phase 13 §2: model-call governance as boundary rules, not per-file call counts.
 *
 *   - The registry: every purpose names a provider, a data class cleared for it and a builder that
 *     a builder module exports; no builder exists that the registry does not name.
 *   - Runtime: callModel (lib/ai/call.ts), which every lane goes through, refuses an unbuilt
 *     payload, an unregistered purpose, the wrong provider and an uncleared class before any I/O.
 *   - The boundary: no file outside the lib/ai transports (and a few declared dev scripts) imports
 *     a provider SDK or holds a provider host or key; every runtime transport routes through
 *     callModel; only lib/ai/call-ledger.ts writes `ai_calls`.
 *
 * A raw provider call outside lib/ai needs the SDK, the host or the key, so it fails here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

import * as adapter from "@/lib/ai/adapter";
import { callModel, CallRefused } from "@/lib/ai/call";
import { CALL_REGISTRY, CLEARED, callRefusal, isCleared, type CallSite } from "@/lib/ai/call-registry";
import { generateGrounded } from "@/lib/ai/gemini-grounded";
import * as geminiBuilders from "@/lib/ai/gemini-payloads";
import * as openRouterBuilders from "@/lib/ai/openrouter-payloads";
import * as jevBuilders from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";

const payloads = { ...jevBuilders, ...geminiBuilders, ...openRouterBuilders };
const registry = CALL_REGISTRY as Record<string, CallSite>;

/**
 * The runtime modules that ARE the provider boundary. Each reason says what it holds. A new entry
 * needs review: it widens the set of files that can reach a provider directly.
 */
const TRANSPORTS: Readonly<Record<string, string>> = {
  "lib/ai/adapter.ts": "the Gemini structured transport and the Files API upload and delete",
  "lib/ai/gemini-grounded.ts": "the Gemini googleSearch-grounded transport for the lookup lane",
  "lib/ai/typesafe.ts": "the TypeSafe System One (Jev) transport: its host and key",
  "lib/ai/openrouter.ts": "the OpenRouter chat-completions transport: its host and key",
  "lib/ai/provider-env.ts":
    "reports whether TYPESAFE_API_KEY/OPENROUTER_API_KEY are set, so callers never read them",
  "lib/ai/gemini-config.ts": "the SDK's ThinkingLevel enum for the generateContent config",
};

/** Dev and eval scripts that hold a provider SDK, host or key. Never run in production or CI. */
const DEV_TRANSPORTS: Readonly<Record<string, string>> = {
  "scripts/ai-canary.ts": "the Gemini SDK canary probe: one direct generateContent call to check the pinned model",
  "scripts/debug/gemini-schema-probe.ts": "a manual probe of Gemini's schema support, run by hand",
  "scripts/coach-live-check.ts": "checks that GEMINI_API_KEY and TYPESAFE_API_KEY are set before a live check",
  "scripts/eval/coach-streak-harness.ts": "checks that GEMINI_API_KEY and TYPESAFE_API_KEY are set before the streak eval",
  "scripts/eval/jev-facets.ts": "loads TYPESAFE_API_KEY for the facet evaluator's refresh run",
  "scripts/eval/jev-facets/cache.ts": "records the raw Jev envelope by matching the System One URL in a fetch wrapper",
  "scripts/model-freshness.ts": "lists Gemini and Jev model names (no user content, no generation) to compare against lib/ai/lanes.ts pins",
  "scripts/openrouter-live-check.ts": "one real OpenRouter structured call, run by hand, with OPENROUTER_API_KEY",
};

/** A provider SDK value import, client, host or key. `import type` is not a transport. */
const PROVIDER = new RegExp([
  String.raw`\bimport\s+(?!type\s)[^;]*?from\s*["']@google\/genai["']`,
  String.raw`\b(?:require|import)\s*\(\s*["']@google\/genai["']`,
  String.raw`new\s+GoogleGenAI\b`,
  String.raw`api\.typesafe\.ai`,
  String.raw`openrouter\.ai`,
  String.raw`generativelanguage\.googleapis\.com`,
  String.raw`\b(?:GEMINI|TYPESAFE|OPENROUTER)_API_KEY\b`,
].join("|"));
/** Opens a provider connection (not just a key check or an enum). */
const CONNECTS = /new\s+GoogleGenAI\b|api\.typesafe\.ai|openrouter\.ai/;
/**
 * A retired provider (Nous Portal and DeepSeek, both removed 2026-10-01): no file, transports
 * included, may hold its host, key or entry point. Reintroducing one means a new registry entry,
 * clearance and review.
 */
const RETIRED = new RegExp([
  String.raw`api\.deepseek\.com`,
  String.raw`\bDEEPSEEK_API_KEY\b`,
  String.raw`\bdeepseekJson\b`,
  String.raw`nousresearch\.com`,
  String.raw`\bNOUS_(?:API_KEY|BASE_URL)\b`,
  String.raw`\bnousCall\b`,
].join("|"));
const LEDGER_WRITE = /\.from\(\s*["']ai_calls["']\s*\)\s*\.(?:insert|upsert|update)\s*\(/;

function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
}

const RUNTIME = [...["app", "lib", "components"].flatMap(sourceFiles), "middleware.ts"].sort();
const SCRIPTS = sourceFiles("scripts").sort();

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the call registry (Phase 13 §2)", () => {
  it("every purpose names a provider, a cleared data class and an exported builder", () => {
    for (const [purpose, site] of Object.entries(registry)) {
      expect(Object.keys(CLEARED), purpose).toContain(site.provider);
      expect(["D0", "D1", "D2"], purpose).toContain(site.dataClass);
      expect(isCleared(site.provider, site.dataClass), purpose).toBe(true);
      expect(typeof (payloads as Record<string, unknown>)[site.builder], purpose).toBe("function");
    }
  });

  it("no builder exists that the registry does not name", () => {
    const named = new Set(Object.values(registry).map((site) => site.builder));
    const exported = Object.entries(payloads)
      .filter(([name, value]) => typeof value === "function" && /Payload$/.test(name)
        && !["mintPayload", "isMintedPayload"].includes(name))
      .map(([name]) => name);
    expect(exported.filter((name) => !named.has(name))).toEqual([]);
  });

  it("states the spec §2 clearance table", () => {
    // openrouter (owner request 2026-10-02): cleared the same as google — the coach's capacity
    // fallback and, with COACH_PROVIDER=openrouter, its primary — gated by its own attestation
    // pair (lib/ai/attestation.ts), never by this clearance alone.
    expect(CLEARED).toEqual({
      google: ["D0", "D1", "D2"], typesafe: ["D0", "D1"], openrouter: ["D0", "D1", "D2"],
    });
  });

  it("refuses an unregistered purpose, the wrong provider and an uncleared class", () => {
    expect(callRefusal("coach-intent", "typesafe")).toBeNull();
    expect(callRefusal("coach", "google")).toBeNull();
    expect(callRefusal("made-up", "typesafe")).toMatch(/not in the call registry/);
    expect(callRefusal("coach", "typesafe")).toMatch(/registered for google/);
    expect(callRefusal("toString", "typesafe")).toMatch(/not in the call registry/);
    const d2ToJev = { x: { provider: "typesafe", dataClass: "D2", builder: "b" } } as const;
    expect(callRefusal("x", "typesafe", d2ToJev)).toMatch(/not cleared for D2/);
  });

  it("Live dictation is retired: no live-dictation purpose remains", () => {
    expect(callRefusal("coach-dictation-live", "google")).toMatch(/not in the call registry/);
  });
});

describe("runtime refusal of unbuilt payloads, before any I/O", () => {
  const forged = (purpose: string) => ({ purpose, parts: [{ text: "hi" }] }) as never;
  const noDb = () => ({ from: vi.fn() });

  it("callModel refuses a payload its builder module did not mint", async () => {
    const send = vi.fn();
    const ledger = vi.fn();
    await expect(callModel({
      payload: { purpose: "coach" }, provenance: geminiBuilders.geminiProvenance,
      target: () => ({ provider: "google", model: "m", sdkVersion: "1" }), ledger,
      inputHash: () => "h", transport: { send }, accept: (r) => r, price: () => 0, maxAttemptCostUsd: () => 0,
      policy: { attempts: 1, budgetMs: 100, attemptMs: 100, backoffMs: [], retryable: () => false },
    })).rejects.toThrow(CallRefused);
    expect(send).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("generateStructured refuses a forged payload with no provider call and no row", async () => {
    const callGemini = vi.fn();
    const admin = noDb();
    await expect(adapter.generateStructured({ payload: forged("coach"), userId: "u1",
      schema: z.object({ ok: z.boolean() }), admin: admin as never }, { callGemini }))
      .rejects.toThrow(/not made by this purpose's payload builder/);
    expect(callGemini).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("generateGrounded refuses a forged payload with no provider call and no row", async () => {
    const callGeminiGrounded = vi.fn();
    const admin = noDb();
    await expect(generateGrounded({ payload: forged("lookup"), userId: "u1",
      admin: admin as never, timeoutMs: 1_000 }, { callGeminiGrounded }))
      .rejects.toThrow(/not made by this purpose's payload builder/);
    expect(callGeminiGrounded).not.toHaveBeenCalled();
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("systemOne answers null to a forged payload with no request", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "k");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = { purpose: "coach-verify", state: {}, questions: {} } as never;
    await expect(systemOne(fake, { userId: "u1" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the provider boundary", () => {
  it("only the lib/ai transports and declared dev scripts hold a provider SDK, host or key", () => {
    expect(RUNTIME.filter((f) => PROVIDER.test(code(f))))
      .toEqual(Object.keys(TRANSPORTS).sort());
    expect(SCRIPTS.filter((f) => PROVIDER.test(code(f))))
      .toEqual(Object.keys(DEV_TRANSPORTS).sort());
    expect(Object.entries({ ...TRANSPORTS, ...DEV_TRANSPORTS })
      .filter(([, why]) => why.trim().length < 20).map(([file]) => file)).toEqual([]);
  });

  it("every runtime transport that opens a provider connection goes through callModel", () => {
    const connecting = Object.keys(TRANSPORTS).filter((f) => CONNECTS.test(code(f)));
    expect(connecting.length).toBeGreaterThan(0);
    expect(connecting.filter((f) => !/\bcallModel\s*\(/.test(code(f)))).toEqual([]);
  });

  it("only the ledger writes ai_calls", () => {
    expect(RUNTIME.filter((f) => LEDGER_WRITE.test(code(f)))).toEqual(["lib/ai/call-ledger.ts"]);
  });

  it("the adapter exports no raw transport: builder output is the only way in", () => {
    for (const raw of ["geminiCall", "uploadToFiles", "deleteFromFiles"]) {
      expect(raw in adapter, raw).toBe(false);
    }
  });

  it("no file holds a retired provider's host, key or entry point", () => {
    expect([...RUNTIME, ...SCRIPTS].filter((f) => RETIRED.test(code(f)))).toEqual([]);
  });
});
