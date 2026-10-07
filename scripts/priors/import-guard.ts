/**
 * The write guard of the W4 FNDDS-inputs import (Sol W4 r1 WARN 3, r2 BLOCK 2). Stricter than the
 * shared `assertWriteTarget`, which only knows the one hard-coded production project:
 *
 *   no --commit                 a dry run: allowed against any target (it writes nothing);
 *   --commit, loopback host     allowed (http or https, host 127.0.0.1, localhost or ::1, no
 *                               user info): a local stack;
 *   --commit, any other target  refused unless --production is passed, --project-ref <ref> is
 *                               given, and the URL is EXACTLY `https://<ref>.supabase.co` (an
 *                               optional trailing `/`): no other domain or suffix, no user info,
 *                               no port, no path, query or fragment, no other scheme. The import
 *                               talks to the API URL only; it uses no database URL, so the pooler
 *                               form is never accepted.
 * The known Meal Companion production ref is an extra check: a URL that names it anywhere must
 * be exactly that project's API URL. --production or --project-ref against a loopback host is
 * refused, so a flag meant for production never quietly writes somewhere else.
 *
 * Pure; reads only its inputs.
 */
export const KNOWN_PRODUCTION_REF = "fivatgdpuenszxxnijpc";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SUPABASE_API = /^([a-z0-9]{20})\.supabase\.co$/;

export type ImportArgs = { commit: boolean; production: boolean; projectRef: string | null };

export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const out: ImportArgs = { commit: false, production: false, projectRef: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") out.commit = true;
    else if (arg === "--production") out.production = true;
    else if (arg === "--dry-run") continue;
    else if (arg === "--project-ref") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--project-ref needs a value");
      out.projectRef = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (argv.includes("--dry-run") && out.commit) throw new Error("--dry-run and --commit exclude each other");
  return out;
}

/** Throws unless this run may write to `url`. */
export function assertImportTarget(args: ImportArgs, url: string | undefined): void {
  if (!args.commit) {
    if (args.production) throw new Error("--production only applies together with --commit");
    return;
  }
  let target: URL;
  try {
    target = new URL(url ?? "");
  } catch {
    throw new Error("--commit refuses: SUPABASE_URL is missing or not a URL");
  }
  if (target.username || target.password) throw new Error("--commit refuses a target URL with user info");
  if (LOOPBACK.has(target.hostname) && (target.protocol === "http:" || target.protocol === "https:")) {
    if (args.production || args.projectRef) {
      throw new Error("--production / --project-ref given, but the target is a local stack");
    }
    return;
  }
  if (!args.production || !args.projectRef) {
    throw new Error(`--commit refuses non-local host ${target.hostname} without --production and --project-ref <ref>`);
  }
  const exact = SUPABASE_API.exec(target.hostname);
  if (target.protocol !== "https:" || target.port !== "" || !exact || (target.pathname !== "/" && target.pathname !== "")
    || target.search !== "" || target.hash !== "" || url !== `https://${target.hostname}${url?.endsWith("/") ? "/" : ""}`) {
    throw new Error(`--commit refuses ${url}: a remote target must be exactly https://<ref>.supabase.co`);
  }
  if (exact[1] !== args.projectRef) {
    throw new Error(`--project-ref ${args.projectRef} does not match the target project ${exact[1]}`);
  }
  if (url.includes(KNOWN_PRODUCTION_REF) && exact[1] !== KNOWN_PRODUCTION_REF) {
    throw new Error(`the target URL names ${KNOWN_PRODUCTION_REF} but resolves to ${exact[1]}`);
  }
}
