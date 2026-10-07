/**
 * Phase 13 §3.4, slice 7: weekly model-freshness check
 * (.github/workflows/model-freshness.yml). Lists the Gemini and Jev models the keys can
 * see, compares them against the pins in lib/ai/lanes.ts (lib/ai/model-freshness.ts owns that
 * comparison, unit tested with no live call), and opens or updates the one tracking issue
 * (scripts/model-freshness-github.ts) when a newer pinned-family model exists. It never changes a
 * pin, and it never prints a key: keys travel only in request headers, and only model names reach
 * a log line or an issue body.
 *
 *   pnpm exec tsx scripts/model-freshness.ts
 *
 * Env: GEMINI_API_KEY, TYPESAFE_API_KEY (repo secrets; a missing one skips that
 * provider, the same no-op-before-the-secret-exists pattern as scripts/check-migration-drift.ts),
 * GITHUB_TOKEN and GITHUB_REPOSITORY (set by the workflow — only needed to file the issue).
 */
import {
  freshnessFindings, freshnessIssueBody, parseModelIds, type FreshnessProvider, watchedPins,
} from "@/lib/ai/model-freshness";
import { openOrUpdateIssue } from "@/scripts/model-freshness-github";

type ModelList = { label: string; url: string; headers: (key: string) => Record<string, string> };

const LISTS: Record<FreshnessProvider, ModelList & { env: string }> = {
  google: {
    label: "Gemini", env: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: (key) => ({ "x-goog-api-key": key }),
  },
  typesafe: {
    label: "Jev", env: "TYPESAFE_API_KEY", url: "https://api.typesafe.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

async function modelIds(provider: FreshnessProvider): Promise<string[]> {
  const list = LISTS[provider];
  const key = process.env[list.env];
  if (!key) {
    console.log(`model freshness: ${list.env} not set, skipping ${list.label}`);
    return [];
  }
  const res = await fetch(list.url, { headers: list.headers(key) });
  if (!res.ok) throw new Error(`${list.label} models list returned ${res.status}`);
  return parseModelIds(await res.json());
}

async function main(): Promise<void> {
  const pins = watchedPins();
  const [google, typesafe] = await Promise.all((["google", "typesafe"] as const).map(modelIds));
  const findings = freshnessFindings(pins, { google, typesafe });

  if (findings.length === 0) {
    console.log(`model freshness: every watched pin is current (${pins.length} pins checked)`);
    return;
  }
  for (const { pin, newer } of findings) {
    console.log(`model freshness: ${pin.lane} pinned to ${pin.model}; newer: ${newer.join(", ")}`);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.log("model freshness: GITHUB_TOKEN / GITHUB_REPOSITORY not set, skipping issue");
    return;
  }
  console.log(`model freshness: ${await openOrUpdateIssue(repo, token, freshnessIssueBody(findings))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "model freshness failed");
  process.exit(1);
});
