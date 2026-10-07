/**
 * Phase 13 §3.4, slice 7: the pure comparison half of the weekly model-freshness workflow
 * (.github/workflows/model-freshness.yml, scripts/model-freshness.ts). It never calls a model
 * provider or GitHub itself — the script does that — so the "is there a newer pinned-family
 * model" question can be unit tested with no live call and no network (§9's own requirement).
 *
 * It never changes a pin: lib/ai/lanes.ts stays the one place a pin is written, by a human PR
 * with a lane-bench report attached (§3.2). This module only ever reports.
 *
 * Pure. No I/O.
 */
import { LANES, type Lane, type LaneName } from "@/lib/ai/lanes";

export type FreshnessProvider = "google" | "typesafe";

const WATCHED: readonly string[] = ["google", "typesafe"];

/**
 * A pin on a moving alias ("jev-latest") has no version of its own: it is compared against the
 * concrete version it was last lane-benched as. `null` means none is recorded yet, so every
 * versioned model the provider lists reads as newer until someone records one here — in the same
 * reviewed PR as the bench report, never by this workflow.
 */
export const ALIAS_BENCHED: Readonly<Record<string, string | null>> = {
  // Keyed off the lane table, never a second model-id literal (tests/ai/lanes.test.ts).
  [LANES.judge.model]: null,
};
const ALIAS = /-latest$/;

export type ModelPin = { lane: LaneName; provider: FreshnessProvider; model: string };

/** Every lane pinned to a provider this workflow watches — read straight off `LANES`, never a
 *  second, hand-kept list that could drift from it. */
export function watchedPins(): ModelPin[] {
  return (Object.entries(LANES) as [LaneName, Lane][])
    .filter((entry): entry is [LaneName, Lane & { provider: FreshnessProvider; model: string }] =>
      entry[1].provider !== null && WATCHED.includes(entry[1].provider) && entry[1].model !== null)
    .map(([lane, def]) => ({ lane, provider: def.provider, model: def.model }));
}

const VERSION_TOKEN = /\d+(?:\.\d+)*/g;

/** A model id with every version-shaped token (and a trailing -latest alias) collapsed to one
 *  placeholder, so "gemini-3.6-flash" and "gemini-3.8-flash" read as the same family, "jev-latest"
 *  reads as the family of "jev-2.1", and "deepseek-flash" and "deepseek-reasoner" differ. */
export function modelFamily(modelId: string): string {
  return modelId.toLowerCase().replace(ALIAS, "-0").replace(VERSION_TOKEN, "\u0000");
}

/** Every version-shaped token in the id, each as its dotted parts ("3.10" is [3, 10], never 3.1).
 *  A model with no version token at all (bare "deepseek-flash") sorts as the oldest: []. */
export function modelVersion(modelId: string): number[][] {
  return (modelId.toLowerCase().match(VERSION_TOKEN) ?? [])
    .map((token) => token.split(".").map(Number));
}

/** Token by token, part by part; a missing part reads as 0 ("4" and "4.0" are equal). */
function compareVersions(a: readonly number[][], b: readonly number[][]): number {
  for (let t = 0; t < Math.max(a.length, b.length); t++) {
    const x = a[t] ?? [];
    const y = b[t] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const diff = (x[i] ?? 0) - (y[i] ?? 0);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

/** Every model id from `available` that is the same family as `pinned` and strictly newer,
 *  newest first. An alias pin compares against its benched version (ALIAS_BENCHED) and only
 *  counts a model that carries a version at all. */
export function newerModelsFor(
  pinned: string, available: readonly string[],
  benched: Readonly<Record<string, string | null>> = ALIAS_BENCHED,
): string[] {
  const family = modelFamily(pinned);
  const alias = ALIAS.test(pinned.toLowerCase());
  const reference = alias ? benched[pinned.toLowerCase()] ?? null : pinned;
  const pinnedVersion = reference === null ? [] : modelVersion(reference);
  return available
    .filter((id) => id.toLowerCase() !== pinned.toLowerCase() && modelFamily(id) === family
      && (!alias || modelVersion(id).length > 0)
      && compareVersions(modelVersion(id), pinnedVersion) > 0)
    .sort((a, b) => compareVersions(modelVersion(b), modelVersion(a)));
}

/** Model ids from a provider's list response: `{ models: [{ name }] }` (Gemini),
 *  `{ data: [{ id }] }` (OpenAI-style, e.g. Jev), or a bare list. Anything else is empty. */
export function parseModelIds(body: unknown): string[] {
  const list = Array.isArray(body) ? body
    : body && typeof body === "object"
      ? (body as { data?: unknown; models?: unknown }).data
        ?? (body as { models?: unknown }).models : [];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => typeof entry === "string" ? entry
    : entry && typeof entry === "object"
      ? (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name
      : undefined)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.replace(/^models\//, ""));
}

export type FreshnessFinding = { pin: ModelPin; newer: readonly string[] };

/** One finding per watched pin that has a newer same-family model available — a pin with nothing
 *  newer contributes nothing, so an empty result means "nothing to report", not "nothing found". */
export function freshnessFindings(
  pins: readonly ModelPin[],
  availableByProvider: Readonly<Partial<Record<FreshnessProvider, readonly string[]>>>,
): FreshnessFinding[] {
  return pins.flatMap((pin) => {
    const newer = newerModelsFor(pin.model, availableByProvider[pin.provider] ?? []);
    return newer.length > 0 ? [{ pin, newer }] : [];
  });
}

/** The issue body the script opens or updates — names only, never a key, never raw API output. */
export function freshnessIssueBody(findings: readonly FreshnessFinding[]): string {
  const lines = findings.map(({ pin, newer }) => {
    const benched = ALIAS.test(pin.model) ? ALIAS_BENCHED[pin.model] ?? null : undefined;
    const pinned = benched === undefined ? `\`${pin.model}\``
      : `the moving alias \`${pin.model}\` (last benched as ${benched ? `\`${benched}\`` : "nothing recorded"})`;
    return `- **${pin.lane}** is pinned to ${pinned}; newer available: ${
      newer.map((id) => `\`${id}\``).join(", ")}`;
  });
  return [
    "The weekly model-freshness check found a newer model in a pinned family.",
    "",
    ...lines,
    "",
    "This never changes a pin. A pin changes only through a PR carrying a lane-bench report",
    "(`scripts/eval/lane-bench.ts`, Phase 13 §3.2).",
  ].join("\n");
}

export const FRESHNESS_ISSUE_TITLE = "Model freshness: a newer pinned-family model is available";
export const FRESHNESS_ISSUE_LABEL = "model-freshness";
