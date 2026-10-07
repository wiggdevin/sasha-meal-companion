/**
 * Spec 3.5 (Phase 9 slice 3): the list of admin-client entry points is generated from the source
 * and must equal tests/tenancy/admin-entry-points.json, so a new entry point fails CI until it is
 * declared.
 *
 * Every entry must have a cross-user canary test: a tests/tenancy/admin-*.test.ts file that seeds
 * B with a canary and imports the entry itself or, through `via`, the module that reaches it. The
 * gate fails for an entry without one (review r2 finding 2), unless the entry is listed in
 * tests/tenancy/admin-pending.allowlist.json: an explicit, dated exception that the PR body names as
 * open work for Devin. The allowlist cannot go stale: a listed entry that is now covered, or no
 * longer exists, fails too. The count and names of open exceptions are printed on every run.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import entries from "./admin-entry-points.json";
import allowlist from "./admin-pending.allowlist.json";

type Entry = { test?: string; via?: string };
const declared = entries as Record<string, Entry>;
const allowed = allowlist as { date: string; approver: string; openItem: string;
  entries: Record<string, string> };

/**
 * Any way a module can hold the service-role client (review r2 finding 3): a static or dynamic
 * import of the admin module (any path form), a call to `adminClient(` or `adminClientForCli(`, the
 * service-role key itself, or a parameter typed as an admin client.
 */
const USES_ADMIN = new RegExp([
  String.raw`["'](?:@\/|(?:\.\.?\/)+)(?:lib\/)?server\/admin["']`,
  String.raw`\badminClient(?:ForCli)?\s*\(`,
  String.raw`SUPABASE_(?:TEST_)?SERVICE_ROLE_KEY`,
  String.raw`\badmin\??\s*:\s*(?:SupabaseClient|ReturnType<typeof adminClient>)`,
].join("|"));

/** The module that creates the client; every other holder of it is an entry point. */
const ADMIN_MODULE = "lib/server/admin.ts";

/** Source text without comments, so a comment that names adminClient() is not an entry point. */
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
}

const moduleOf = (file: string) => `@/${file.replace(/\.tsx?$/, "")}`;

/** True when the entry names a tenancy canary test that imports it or its declared caller. */
function hasCanary(file: string, v: Entry): boolean {
  if (!v.test || !/^tests\/tenancy\/admin-[a-z-]+\.test\.ts$/.test(v.test)) return false;
  // A route is covered only by a test that calls the route itself (review r3 finding 1): a test
  // of the helpers behind it cannot see the route's own identity binding.
  if (file.startsWith("app/") && v.via !== undefined && v.via !== moduleOf(file)) return false;
  if (!existsSync(v.test)) return false;
  const src = readFileSync(v.test, "utf8");
  return /canary/i.test(src) && src.includes(`"${v.via ?? moduleOf(file)}"`);
}

const uncovered = Object.entries(declared).filter(([file, v]) => !hasCanary(file, v))
  .map(([file]) => file).sort();
const open = Object.keys(allowed.entries).sort();

describe("admin-client entry points (spec 3.5)", () => {
  it("the generated list equals the manifest", () => {
    const found = ["app", "lib"].flatMap(sourceFiles)
      .filter((f) => f !== ADMIN_MODULE && USES_ADMIN.test(code(f))).sort();
    expect(found).toEqual(Object.keys(declared).sort());
  });

  it("every entry has a canary test or is an allowlisted open exception", () => {
    expect(uncovered.filter((f) => !(f in allowed.entries))).toEqual([]);
  });

  it("the allowlist names only entries that exist and still lack a canary test", () => {
    expect(open.filter((f) => !uncovered.includes(f))).toEqual([]);
  });

  it("the allowlist is dated, names its approver and its open item, and gives each reason", () => {
    expect(allowed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(allowed.approver).toBe("Devin");
    expect(allowed.openItem).toMatch(/PR #\d+/);
    expect(Object.entries(allowed.entries).filter(([, why]) => why.trim().length < 20)
      .map(([f]) => f)).toEqual([]);
  });

  it(`OPEN: ${open.length} of ${Object.keys(declared).length} admin entry points have no canary test yet`,
    () => {
      console.info(`admin entry points without a canary test (${open.length}, allowlisted ${
        allowed.date}, ${allowed.openItem}):\n${open.map((f) => `  - ${f}`).join("\n")}`);
      expect(open.length).toBe(uncovered.length);
    });
});
