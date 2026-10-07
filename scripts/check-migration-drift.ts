/**
 * Fails when the migrations in supabase/migrations are not the migrations a database has applied.
 *
 *   pnpm exec tsx scripts/check-migration-drift.ts
 *
 * Env: SUPABASE_ACCESS_TOKEN (a Management API token) and SUPABASE_PROJECT_REF, or SUPABASE_URL to
 * derive the ref from. Both unset is a deliberate no-op, so this is safe in CI before the secrets
 * exist — the same pattern as the integration suite in .github/workflows/ci.yml.
 *
 * Read-only. It reports drift; it never applies a migration. Applying to production stays a
 * human action — see docs/CONTRIBUTING.md.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { diffMigrations, versionFromFilename } from "@/lib/migrations/drift";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase/migrations");

function repoVersions(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .map(versionFromFilename)
    .filter((v): v is string => v !== null)
    .sort();
}

function projectRef(): string | null {
  const explicit = process.env.SUPABASE_PROJECT_REF;
  if (explicit) return explicit;
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  const match = /^https:\/\/([^.]+)\.supabase\.co/.exec(url);
  return match === null ? null : match[1];
}

async function appliedVersions(ref: string, token: string): Promise<string[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "select version from supabase_migrations.schema_migrations order by version;",
    }),
  });
  if (!res.ok) {
    // Never print the body: a Management API error can echo connection detail.
    throw new Error(`Management API returned ${res.status}`);
  }
  const rows = (await res.json()) as Array<{ version: string }>;
  return rows.map((r) => r.version);
}

async function main(): Promise<void> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = projectRef();
  if (!token || !ref) {
    console.log("migration drift: skipped (SUPABASE_ACCESS_TOKEN / project ref not set)");
    return;
  }

  const repo = repoVersions();
  const applied = await appliedVersions(ref, token);
  const drift = diffMigrations(repo, applied);

  console.log(`repo: ${repo.length} migrations, database: ${applied.length} applied`);
  if (drift.clean) {
    console.log("migration drift: none");
    return;
  }
  for (const v of drift.missing) console.error(`  MISSING in database: ${v}`);
  for (const v of drift.unknown) console.error(`  UNKNOWN to repo:     ${v}`);
  console.error(
    "\nThe database is not running this repo's schema. Apply the missing migrations before " +
    "treating a deploy as complete — see docs/CONTRIBUTING.md.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
