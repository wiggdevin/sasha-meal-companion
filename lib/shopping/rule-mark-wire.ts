import type { RuleMark } from "@/lib/types";

/** Longest reason the phone shows; a longer one is not a sentence the server meant to send. */
const MAX_REASON = 500;

/**
 * One `ruleMark` off the wire (2026-10-05, shopping routes F4): `{ verdict: "blocked" | "unknown",
 * reason }` or null. Missing is null. A malformed mark is dropped to null rather than thrown: a mark
 * only ever adds a tag beside a line, so a bad one must never cost the user the line itself.
 */
export function parseRuleMark(value: unknown): RuleMark | null {
  if (!value || typeof value !== "object") return null;
  const { verdict, reason } = value as { verdict?: unknown; reason?: unknown };
  if (verdict !== "blocked" && verdict !== "unknown") return null;
  if (typeof reason !== "string") return null;
  const text = reason.trim();
  if (!text || text.length > MAX_REASON) return null;
  return { verdict, reason: text };
}

/** A shopping line or pantry item with its mark validated; every other field is left as it came. */
export function withRuleMark<T extends { ruleMark?: RuleMark | null }>(row: T): T {
  if (!row || typeof row !== "object") return row;
  return { ...row, ruleMark: parseRuleMark((row as { ruleMark?: unknown }).ruleMark) };
}

/** Every row of a list, marks validated. A list that is not an array is returned unchanged. */
export function withRuleMarks<T extends { ruleMark?: RuleMark | null }>(rows: T[]): T[] {
  return Array.isArray(rows) ? rows.map(withRuleMark) : rows;
}
