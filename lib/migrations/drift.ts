/**
 * Compares the migrations in `supabase/migrations` against the versions a database has actually
 * applied (`supabase_migrations.schema_migrations`).
 *
 * This exists because on 2026-09-14 production was four migrations behind the repo with nothing
 * reporting it. Migrations reach production by hand; Vercel's Git integration builds the app and
 * touches no schema. Code and schema can therefore drift apart on any merge, and the only symptom
 * is a function quietly running its old body.
 */

/** The leading timestamp of a migration filename, or null when the name is not one. */
export function versionFromFilename(filename: string): string | null {
  const match = /^(\d{14})_.+\.sql$/.exec(filename);
  return match === null ? null : match[1];
}

export type MigrationDrift = {
  /** In the repo, not applied to the database. The dangerous direction. */
  missing: string[];
  /** Applied to the database, absent from the repo. A rollback, or a hand-applied migration. */
  unknown: string[];
  clean: boolean;
};

export function diffMigrations(repo: string[], applied: string[]): MigrationDrift {
  const appliedSet = new Set(applied);
  const repoSet = new Set(repo);
  const missing = [...repoSet].filter((v) => !appliedSet.has(v)).sort();
  const unknown = [...appliedSet].filter((v) => !repoSet.has(v)).sort();
  return { missing, unknown, clean: missing.length === 0 && unknown.length === 0 };
}
