/**
 * Crash reports from the phone (audit 2026-10-08 §5, no-app-wide-error-boundary-or-crash-reporting;
 * W053). No vendor and no table: the client posts a minimal report to `POST /api/client-errors`,
 * which writes it to the function log under CLIENT_ERROR_LOG_PREFIX so Vercel's runtime logs hold it.
 *
 * Privacy (W053, the review BLOCK on the parked branch): a report holds allowlisted values only.
 * No free text leaves the phone — not the error message, not the path, not the query. The message
 * is read once, on the phone, to pick a fixed `code` (`classifyError`) and is then dropped; the path
 * becomes one of the app's route patterns (`routePattern`), else `other`; the name must be a known
 * error class, else `Other`; the digest and build must have Next's and git's own shapes. Both sides
 * run `cleanReport`: the client so nothing else leaves the phone, the server so a hand-made request
 * cannot log anything else.
 */

export const CLIENT_ERRORS_URL = "/api/client-errors";
export const CLIENT_ERROR_LOG_PREFIX = "[client-error]";
export const CLIENT_ERROR_MAX_BYTES = 4 * 1024;

export const CLIENT_ERROR_SOURCES = ["boundary", "global-boundary", "window-error", "unhandled-rejection"] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

/** Built-in and DOM error classes, plus Next's chunk error. Any other name is reported as `Other`. */
export const CLIENT_ERROR_NAMES = [
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "ChunkLoadError", "AbortError", "TimeoutError", "NetworkError", "NotAllowedError",
  "NotFoundError", "NotReadableError", "NotSupportedError", "QuotaExceededError", "SecurityError",
  "InvalidStateError", "DataCloneError", "DataError", "ConstraintError", "TransactionInactiveError",
  "VersionError", "UnknownError", "Other",
] as const;
export type ClientErrorName = (typeof CLIENT_ERROR_NAMES)[number];

/** What went wrong, as a fixed word. `unknown` when no rule below matches. */
export const CLIENT_ERROR_CODES = [
  "chunk_load", "hydration", "network", "quota", "abort", "storage", "undefined_value",
  "not_a_function", "not_defined", "render_loop", "server_render", "non_error", "unknown",
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Every page the app serves (a test walks `app/` and holds this list to it). */
export const CLIENT_ERROR_ROUTES = [
  "/", "/body", "/coach", "/foods", "/onboarding", "/recipes", "/scan", "/settings", "/sign-in",
  "/week", "/design", "/design/:page", "other",
] as const;
export type ClientErrorRoute = (typeof CLIENT_ERROR_ROUTES)[number];

export type ClientErrorReport = {
  source: ClientErrorSource;
  name: ClientErrorName;
  code: ClientErrorCode;
  digest: string | null;
  route: ClientErrorRoute;
  build: string | null;
  at: string;
};

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

// Order matters: the first rule that matches wins.
const CODE_RULES: readonly [ClientErrorCode, (name: string, message: string) => boolean][] = [
  ["chunk_load", (n, m) => n === "ChunkLoadError" || /loading (css )?chunk|dynamically imported module/i.test(m)],
  ["hydration", (_, m) => /hydrat/i.test(m)],
  ["quota", (n, m) => n === "QuotaExceededError" || /quota/i.test(m)],
  ["abort", (n) => n === "AbortError" || n === "TimeoutError"],
  ["network", (n, m) => n === "NetworkError" || /^(failed to fetch|load failed|networkerror)/i.test(m)],
  ["storage", (n, m) => /^(DataError|ConstraintError|TransactionInactiveError|VersionError|UnknownError|InvalidStateError)$/.test(n)
    || /indexeddb|idbdatabase|localstorage/i.test(m)],
  ["undefined_value", (_, m) => /cannot read propert|undefined is not an object|null is not an object|of (undefined|null)/i.test(m)],
  ["not_a_function", (_, m) => /is not a function/i.test(m)],
  ["not_defined", (n, m) => n === "ReferenceError" || /is not defined/i.test(m)],
  ["render_loop", (_, m) => /maximum update depth|too many re-renders/i.test(m)],
  ["server_render", (_, m) => /server components render/i.test(m)],
];

/** A fixed code for an error. The message is only matched here, on the phone; it is never sent. */
export function classifyError(name: string, message: string): ClientErrorCode {
  for (const [code, test] of CODE_RULES) if (test(name, message)) return code;
  return "unknown";
}

/** The app route pattern a location belongs to; any path the app does not serve is `other`. */
export function routePattern(value: string): ClientErrorRoute {
  let path: string;
  try { path = new URL(value, "http://local").pathname; } catch { return "other"; }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/design/:page" || /^\/design\/[a-z0-9-]+$/.test(path)) return "/design/:page";
  return includes(CLIENT_ERROR_ROUTES, path) && path !== "other" ? path : "other";
}

/** Next's digest: a decimal string hash, optionally `@E<code>`. Anything else is not kept. */
function cleanDigest(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,12}(@E\d{1,6})?$/.test(value) ? value : null;
}

/** A git commit (the deployment's VERCEL_GIT_COMMIT_SHA). */
function cleanBuild(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

function cleanAt(value: unknown, now: Date): string {
  if (typeof value === "string" && value.length <= 40) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now.toISOString();
}

/** Any input → a report that holds only allowlisted values; everything else is dropped. */
export function cleanReport(input: unknown, now: Date = new Date()): ClientErrorReport {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    source: includes(CLIENT_ERROR_SOURCES, raw.source) ? raw.source : "boundary",
    name: includes(CLIENT_ERROR_NAMES, raw.name) ? raw.name : "Other",
    code: includes(CLIENT_ERROR_CODES, raw.code) ? raw.code : "unknown",
    digest: cleanDigest(raw.digest),
    route: typeof raw.route === "string" ? routePattern(raw.route) : "other",
    build: cleanBuild(raw.build),
    at: cleanAt(raw.at, now),
  };
}

/** A thrown value as (name, code, digest): its message is classified here and goes no further. */
export function describeThrown(value: unknown): { name: string; code: ClientErrorCode; digest: unknown } {
  if (value instanceof Error) {
    return { name: value.name, code: classifyError(value.name, String(value.message ?? "")),
      digest: (value as { digest?: unknown }).digest };
  }
  if (typeof value === "string") return { name: "Error", code: classifyError("Error", value), digest: undefined };
  return { name: "Other", code: "non_error", digest: undefined };
}
