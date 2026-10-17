/**
 * The gate between a model-produced tool call and an executor — spec "Engines and logic",
 * invariant 1: dispatch is a lookup over REGISTRY, an unknown name returns an error string
 * to the model, and it never reaches a function reference.
 *
 * userId comes from the caller, never from the model: it is not a parameter here at all.
 *
 * Pure. No I/O, no Supabase import.
 */

import { lookupTool, type CoachTool, type ToolName } from "@/lib/coach/registry";
import { sanitizeText, type Untrusted } from "@/lib/coach/envelope";

export type ToolResult =
  | { name: ToolName; ok: true; data: Untrusted }
  | { name: ToolName; ok: false; error: string };

/** Where and why an argument failed: the schema path and zod's issue code, never the value. */
export type ArgIssue = { path: string; code: string };

export type ValidatedCall =
  | { ok: true; tool: CoachTool; args: unknown }
  | { ok: false; error: string; issues?: ArgIssue[] };

export const UNKNOWN_TOOL_PREFIX = "unknown_tool: ";
export const INVALID_ARGS_PREFIX = "invalid_arguments: ";

/** The echoed name is sanitised and clipped: an error string goes straight back into the prompt. */
function echo(name: string): string {
  return sanitizeText(String(name)).slice(0, 64);
}

export function validateToolCall(name: string, rawArgs: unknown): ValidatedCall {
  const tool = lookupTool(name);
  if (!tool) return { ok: false, error: `${UNKNOWN_TOOL_PREFIX}${echo(name)}` };

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const issues = parsed.error.issues.slice(0, 8)
      .map((issue) => ({ path: issue.path.join(".") || "(root)", code: String(issue.code) }));
    return { ok: false, error: `${INVALID_ARGS_PREFIX}${echo(detail)}`, issues };
  }
  // parsed.data, not rawArgs: zod strips unknown keys, so an extra "userId" never
  // reaches an executor even as a property it happens to ignore.
  return { ok: true, tool, args: parsed.data };
}
