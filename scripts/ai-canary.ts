/**
 * Phase 0 AI canary. Runs OUTSIDE the push/PR CI, against the real providers. The weekly
 * `.github/workflows/ai-canary.yml` (schedule + manual dispatch, never on push) runs it with the
 * repo's GEMINI_API_KEY secret and skips cleanly when that secret is not set.
 *
 *   pnpm exec tsx scripts/ai-canary.ts
 *   pnpm ai:canary        # once the integration branch adds the package.json script
 *
 * Runs under tsx (contracts §7), which resolves the @/ tsconfig alias.
 *
 * Answers two questions, per pinned Gemini model id (MODELS.textToItems and MODELS.coach are
 * pinned separately — lib/ai/models.ts — and have not always behaved the same, so both are
 * probed) and prints them:
 *   1. Does the pinned Gemini model serve a structured call?
 *   2. Is the Gemini key on a billing-enabled project? Google does not expose a
 *      "paid tier" flag on the API, so the only machine-readable signal is a
 *      quota error naming the free tier. A clean call plus no free-tier quota
 *      error prints "paid (no free-tier quota signal)" — not proof, and the
 *      console URL is printed so Devin can confirm in one click.
 *
 * It reports; it does not write. `docs/ai-data-handling.md` is the retention record and is
 * human-maintained (T4): a canary run must never overwrite it. Nous is not probed: the app has
 * had no Nous transport since 2026-10-01.
 */

import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { assertPinnedSdk, installedGenai, MODELS } from "@/lib/ai/adapter";

const CONSOLE_URL = "https://aistudio.google.com/apikey";
/**
 * A message that names the free tier, or names billing as not enabled, is the one thing this
 * canary exists to catch: the key resolves to a project nobody is paying for.
 */
const UNPAID_RE = /free[_ ]?tier|FreeTier|billing.*not.*enabled/i;

/**
 * "You exceeded your current quota, please check your plan and billing details" is what a
 * billing-less project answers — AND what a paid one answers when it runs past its
 * requests-per-minute (Grok pass 2, MEDIUM 9). It cannot be attributed from the message alone, so
 * it is reported and not refused: failing the canary for a key that is working would train
 * everyone to ignore it.
 */
const QUOTA_RE = /exceeded your current quota|RESOURCE_EXHAUSTED|rate.?limit/i;

export const QUOTA_UNATTRIBUTED = "quota exceeded — unpaid OR rate-capped; re-run in a minute";

/** What one failed probe's message says about the key behind it. */
export function billingVerdict(detail: string): string {
  if (UNPAID_RE.test(detail)) return "UNPAID — free-tier quota reported";
  if (QUOTA_RE.test(detail)) return QUOTA_UNATTRIBUTED;
  return "unknown — call failed";
}

type Probe = { ok: boolean; latencyMs: number; detail: string };
type ModelResult = { model: string; probe: Probe; billing: string };

/** The result of one canary run. `exitCode` is what a shell caller sees; nothing is written. */
type CanaryReport = { results: ModelResult[]; exitCode: 0 | 1 };
/** Injectable so a test can drive this offline: the only live work the canary does. */
type CanaryAI = {
  models: { generateContent: (req: Record<string, unknown>) => Promise<{ text?: string | null }> };
};
type AiFactory = (apiKey: string) => CanaryAI;

async function geminiProbe(
  model: string,
  aiFactory: AiFactory = (apiKey) => new GoogleGenAI({ apiKey }) as unknown as CanaryAI
): Promise<{ probe: Probe; billing: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { probe: { ok: false, latencyMs: 0, detail: "GEMINI_API_KEY is not set" },
    billing: "unknown — no key" };
  const ai = aiFactory(key);
  const started = Date.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: "Return {\"ok\":true} and nothing else." }] }],
      config: {
        temperature: 0, responseMimeType: "application/json",
        responseSchema: { type: "object", properties: { ok: { type: "boolean" } },
          required: ["ok"] },
      },
    });
    return {
      probe: { ok: true, latencyMs: Date.now() - started, detail: res.text ?? "" },
      billing: "paid (no free-tier quota signal)",
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : JSON.stringify(e);
    return {
      probe: { ok: false, latencyMs: Date.now() - started, detail },
      billing: billingVerdict(detail),
    };
  }
}

/**
 * The whole canary, minus process I/O: probe every distinct pinned Gemini model (MODELS.coach
 * is pinned separately from MODELS.textToItems and has, in this repo's own history, behaved
 * differently under load — docs/ai-data-handling.md), print each one's answers, return the
 * combined exit code. Imported by a test, so it must touch nothing but the injected probe and
 * stdout.
 */
export async function canary(
  probeModel: (model: string) => Promise<{ probe: Probe; billing: string }> = geminiProbe
): Promise<CanaryReport> {
  assertPinnedSdk();
  const sdk = installedGenai();
  console.log(`@google/genai ${sdk.version}`);

  const distinctModels = Array.from(new Set(Object.values(MODELS)));
  const results: ModelResult[] = [];
  let exitCode: 0 | 1 = 0;

  for (const model of distinctModels) {
    const { probe: gemini, billing } = await probeModel(model);
    results.push({ model, probe: gemini, billing });

    console.log(`gemini ${model}: ok=${gemini.ok} ${gemini.latencyMs}ms`);
    console.log(`gemini ${model} billing: ${billing}  (confirm at ${CONSOLE_URL})`);

    if (billing.startsWith("UNPAID")) {
      console.error(`the Gemini key resolves to an unpaid project for ${model}. refusing.`);
      exitCode = 1;
    } else if (!gemini.ok) {
      // A failed structural call is a failed canary. The exit code is the only signal a
      // non-interactive run leaves, since this canary does not write a file.
      console.error(`the Gemini structural call failed for ${model}: ${gemini.detail}`);
      exitCode = 1;
    }
  }

  console.log("docs/ai-data-handling.md is not written by this canary; update it by hand.");
  return { results, exitCode };
}

async function main(): Promise<void> {
  const { exitCode } = await canary();
  process.exitCode = exitCode;
}

// Only when run as a script: importing this module (a test) must not probe a live provider.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
