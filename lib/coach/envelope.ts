/**
 * The untrusted-data envelope — spec "Security": tool output enters the prompt only inside a
 * delimiter-tagged block, and the system prompt states that content inside it is data and never
 * instruction. sanitizeText removes the four things that let planted text escape that frame:
 * control characters, bidi reordering, zero-width joiners, and the delimiter token itself. It
 * also removes http/https schemes, so a URL planted in a food name cannot round-trip.
 *
 * The block is fenced by the delimiters themselves, not by backticks: a backtick fence can be
 * closed by three backticks in their data, and these tokens are stripped from the payload first.
 *
 * Pure. No I/O, no Supabase import.
 */

import type { ToolResult } from "@/lib/coach/dispatch";

export const DELIMITER_OPEN = "<<untrusted-data>>";
export const DELIMITER_CLOSE = "<</untrusted-data>>";

export type Untrusted<T = unknown> = { untrusted: true; data: T };

// \n (U+000A) and \t (U+0009) survive: they carry layout, not control.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const DELIMITERS = /<<\/?untrusted-data>>/g;
const SCHEMES = /https?:\/\//gi;

export function sanitizeText(s: string): string {
  return String(s)
    .replace(CONTROLS, "")
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, "")
    .replace(DELIMITERS, "[removed]")
    .replace(SCHEMES, "[link removed]");
}

/** Idempotent: a value already wrapped is returned unchanged, so nesting never doubles. */
export function wrapUntrusted<T>(value: T): Untrusted<T> {
  const record = value as unknown as Record<string, unknown> | null;
  if (record !== null && typeof record === "object" && record.untrusted === true) {
    return value as unknown as Untrusted<T>;
  }
  return { untrusted: true, data: value };
}

export function renderToolResult(r: ToolResult): string {
  const payload = r.ok ? r.data.data : { error: r.error };
  return renderDataBlock("tool", r.name, withoutFoodKeys(payload));
}

/**
 * Phase 18 W6: a food hit and a composed item carry `foodKey` (`food:<user_foods.id>` or
 * `catalog:<id>`) for the phone's signal events only. The model never needs it, so no tool result
 * hands it one: every `foodKey` field is left out of the transcript copy (the card keeps it).
 */
function withoutFoodKeys(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(withoutFoodKeys);
  if (payload === null || typeof payload !== "object") return payload;
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => key !== "foodKey")
    .map(([key, value]) => [key, withoutFoodKeys(value)]));
}

/**
 * The same fence for data that is not a tool result — the injected day context (T6 §2). It is them
 * records reaching the prompt, so it gets the same frame and the same sanitising; the system
 * prompt's rule 2 already tells the model everything inside the fence is data, never instruction.
 */
export function renderDataBlock(kind: string, label: string, payload: unknown): string {
  const body = sanitizeText(JSON.stringify(payload ?? null));
  return `${DELIMITER_OPEN}\n${sanitizeText(kind)}: ${sanitizeText(label)}\n${body}\n${DELIMITER_CLOSE}\n`;
}
