/**
 * Crash reports from the phone (audit 2026-10-08 §5, no-app-wide-error-boundary-or-crash-reporting).
 * No vendor and no table: the client posts a minimal report to `POST /api/client-errors`, which
 * writes it to the function log under CLIENT_ERROR_LOG_PREFIX so Vercel's runtime logs hold it.
 *
 * Privacy: a report carries no account id, no session, no query string, no stack and no request
 * echo. The message is cut to 300 characters after every email address and every digit is
 * replaced, so a weight, a date, an id or an address typed into a field cannot ride along in an
 * error message. Both sides run `cleanReport`: the client so nothing leaves the phone unscrubbed,
 * the server so a hand-made request cannot log anything else.
 */

export const CLIENT_ERRORS_URL = "/api/client-errors";
export const CLIENT_ERROR_LOG_PREFIX = "[client-error]";
export const CLIENT_ERROR_MAX_BYTES = 4 * 1024;
export const MESSAGE_MAX = 300;
const NAME_MAX = 60;
const DIGEST_MAX = 64;
const ROUTE_MAX = 200;
const BUILD_MAX = 64;

export const CLIENT_ERROR_SOURCES = ["boundary", "global-boundary", "window-error", "unhandled-rejection"] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export type ClientErrorReport = {
  source: ClientErrorSource;
  name: string;
  message: string;
  digest: string | null;
  route: string;
  build: string | null;
  at: string;
};

const EMAIL = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[^\s@<>()[\]{}"',;:]+/g;
const DIGIT = /\d/g;
// Control characters (newlines included) are flattened so one report is one log line.
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Emails become `[email]`, every digit `#`, control characters a space; then cut to `max`. */
export function scrubText(value: string, max: number = MESSAGE_MAX): string {
  return value.replace(EMAIL, "[email]").replace(DIGIT, "#").replace(CONTROL, " ").trim().slice(0, max);
}

/** The path alone: no origin, query or hash, and every digit run (an id, a date) as `#`. */
export function scrubRoute(value: string): string {
  let path = value;
  try { path = new URL(value, "http://local").pathname; } catch { path = "/"; }
  if (!path.startsWith("/")) path = "/";
  return scrubText(path, ROUTE_MAX);
}

/** A name token only (`TypeError`, `ChunkLoadError`); anything else is `Error`. */
function cleanName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value) ? value.slice(0, NAME_MAX) : "Error";
}

/** Next's digest is a hash of the server error; keep it only when it looks like one. */
function cleanDigest(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value.slice(0, DIGEST_MAX) : null;
}

function cleanBuild(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) ? value.slice(0, BUILD_MAX) : null;
}

function cleanAt(value: unknown, now: Date): string {
  if (typeof value === "string" && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now.toISOString();
}

function cleanSource(value: unknown): ClientErrorSource {
  return (CLIENT_ERROR_SOURCES as readonly unknown[]).includes(value) ? value as ClientErrorSource : "boundary";
}

/** Any input → a report that holds only the fields above, each bounded and scrubbed. */
export function cleanReport(input: unknown, now: Date = new Date()): ClientErrorReport {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    source: cleanSource(raw.source),
    name: cleanName(raw.name),
    message: typeof raw.message === "string" ? scrubText(raw.message) : "",
    digest: cleanDigest(raw.digest),
    route: typeof raw.route === "string" ? scrubRoute(raw.route) : "/",
    build: cleanBuild(raw.build),
    at: cleanAt(raw.at, now),
  };
}

/** What a thrown value says about itself, without its stack or any other own property. */
export function describeThrown(value: unknown): { name: string; message: string; digest: unknown } {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, digest: (value as { digest?: unknown }).digest };
  }
  if (typeof value === "string") return { name: "Error", message: value, digest: undefined };
  return { name: "Error", message: "Non-error value thrown", digest: undefined };
}
