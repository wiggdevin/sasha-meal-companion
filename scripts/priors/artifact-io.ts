/**
 * Canonical JSON, hashes, sizes and the build-side NCHS gate for the W1b artifacts. Offline build
 * only. The canonical text sorts object keys at every level, so the same rows always give the same
 * bytes and the same sha256 (W1b acceptance 1).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NHANES_RULING_PATH, NHANES_RULING_SHA256 } from "@/lib/foods/universe/prior";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical: non-finite number");
  return JSON.stringify(value ?? null);
}

/** One row or edge per line: diffable in review, still canonical. */
export function artifactText(value: unknown): string {
  if (Array.isArray(value)) return `[\n${value.map(canonical).join(",\n")}\n]\n`;
  if (value && typeof value === "object" && Array.isArray((value as { edges?: unknown }).edges)) {
    const { edges, ...rest } = value as { edges: unknown[] };
    const head = canonical(rest).slice(1, -1);
    return `{${head},"edges":[\n${edges.map(canonical).join(",\n")}\n]}\n`;
  }
  return `${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function gzipBytes(text: string): number {
  return gzipSync(Buffer.from(text), { level: 9 }).length;
}

/**
 * Why the build may not emit NHANES-derived output, or null: the owner's ruling must exist and hash
 * to the approved pin (spec D10, W1b round 2). Shut, the build writes no prior table and no
 * NHANES-derived metric or report.
 */
export function buildGateReason(root: string): "ruling_missing" | "ruling_changed" | null {
  const path = join(root, NHANES_RULING_PATH);
  if (!existsSync(path)) return "ruling_missing";
  return createHash("sha256").update(readFileSync(path)).digest("hex") === NHANES_RULING_SHA256 ? null : "ruling_changed";
}

export function buildGateOpen(root: string): boolean {
  return buildGateReason(root) === null;
}

/** Rounds a rate to 6 decimals, never to 0 or 1. */
export function roundRate(value: number): number {
  return Math.min(0.999999, Math.max(0.000001, Math.round(value * 1e6) / 1e6));
}
