/**
 * Phase 13 §9 R5: the build-time check of the dietary-profile document. `pnpm build` runs this
 * before `next build`, so a document with a schema error, an unresolved profile reference or an
 * untyped time_window stops the build instead of reaching a deploy.
 *
 *   tsx scripts/check-dietary-profiles.ts           # docs/research/dietary-profiles.draft.json
 *   tsx scripts/check-dietary-profiles.ts <file>    # any copy of it, which is how the test seeds a fault
 *
 * The same validation also runs when lib/policy/profiles/catalog.ts loads; this entry point is
 * the one the build itself calls.
 */
import { readFileSync } from "node:fs";
import { loadProfileCatalog } from "@/lib/policy/profiles/loader";
import { validateDietaryProfilesDocument } from "@/lib/policy/profiles/schema";

const FILE = process.argv[2] ?? "docs/research/dietary-profiles.draft.json";

function fail(lines: readonly string[]): never {
  process.stderr.write(`${FILE}: dietary-profile check failed\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  process.exit(1);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(FILE, "utf8"));
} catch (error) {
  fail([`cannot read JSON: ${(error as Error).message}`]);
}

const result = validateDietaryProfilesDocument(raw);
if (!result.valid) fail(result.issues.map((issue) => `${issue.path}: ${issue.message}`));

try {
  const catalog = loadProfileCatalog(result.data.profiles);
  process.stdout.write(`${FILE}: ${catalog.size} profiles valid\n`);
} catch (error) {
  fail([(error as Error).message]);
}
