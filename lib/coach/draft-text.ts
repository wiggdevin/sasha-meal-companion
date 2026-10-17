/**
 * OD06 / W091: the reply text inside a turn step that is still arriving.
 *
 * The coach's model answers one JSON object (lib/coach/wire.ts `turnStepProviderSchema`), streamed
 * a few characters at a time. `draftTextOf` reads that unfinished object and returns what the
 * top-level `text` string holds so far, decoded, but only once the top-level `kind` is known to be
 * "final": a tool step's text is never shown. Anything it cannot read yet is `null`, never a
 * guess. The draft is a preview; the saved reply always replaces it.
 *
 * Pure. No I/O.
 */

const WS = /\s/;

type Cursor = { s: string; i: number };

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && WS.test(c.s[c.i])) c.i += 1;
}

/**
 * A JSON string starting at the opening quote. `done` is false when the input ends first; `value`
 * is then the decoded prefix, less any escape the input cut in half.
 */
function readString(c: Cursor): { value: string; done: boolean } {
  c.i += 1; // the opening quote
  let value = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\"") { c.i += 1; return { value, done: true }; }
    if (ch !== "\\") { value += ch; c.i += 1; continue; }
    const next = c.s[c.i + 1];
    if (next === undefined) return { value, done: false };
    if (next === "u") {
      const hex = c.s.slice(c.i + 2, c.i + 6);
      if (hex.length < 4) return { value, done: false };
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, done: false };
      value += String.fromCharCode(parseInt(hex, 16));
      c.i += 6;
      continue;
    }
    const simple: Record<string, string> = {
      "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
    };
    value += simple[next] ?? next;
    c.i += 2;
  }
  return { value, done: false };
}

/** Skips one value of any kind. False when the input ends inside it. */
function skipValue(c: Cursor): boolean {
  skipWs(c);
  const ch = c.s[c.i];
  if (ch === undefined) return false;
  if (ch === "\"") return readString(c).done;
  if (ch === "{" || ch === "[") {
    let depth = 0;
    while (c.i < c.s.length) {
      const cur = c.s[c.i];
      if (cur === "\"") { if (!readString(c).done) return false; continue; }
      if (cur === "{" || cur === "[") depth += 1;
      if (cur === "}" || cur === "]") {
        depth -= 1;
        if (depth === 0) { c.i += 1; return true; }
      }
      c.i += 1;
    }
    return false;
  }
  // A number, true, false or null: up to the next delimiter.
  while (c.i < c.s.length && !/[,}\]\s]/.test(c.s[c.i])) c.i += 1;
  return c.i < c.s.length;
}

/** Strips the ```json fence a chat model sometimes puts in front of the object. */
function withoutFence(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("```")) return trimmed;
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? "" : trimmed.slice(newline + 1);
}

export function draftTextOf(raw: string): string | null {
  const c: Cursor = { s: withoutFence(raw), i: 0 };
  skipWs(c);
  if (c.s[c.i] !== "{") return null;
  c.i += 1;
  let kind: string | null = null;
  let text: { value: string; done: boolean } | null = null;
  for (;;) {
    skipWs(c);
    const ch = c.s[c.i];
    if (ch === undefined || ch === "}") break;
    if (ch === ",") { c.i += 1; continue; }
    if (ch !== "\"") return null;
    const key = readString(c);
    if (!key.done) break;
    skipWs(c);
    if (c.s[c.i] !== ":") break;
    c.i += 1;
    skipWs(c);
    if (c.i >= c.s.length) break;
    if ((key.value === "kind" || key.value === "text") && c.s[c.i] === "\"") {
      const value = readString(c);
      if (key.value === "text") text = value;
      else if (value.done) kind = value.value;
      if (!value.done) break;
      continue;
    }
    if (!skipValue(c)) break;
  }
  if (kind !== "final" || text === null) return null;
  return text.value;
}
