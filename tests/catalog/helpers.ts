import { execFileSync } from "node:child_process";

/** A Supabase branch for integration work. Both URLs come from the branch db-branch.sh creates. */
export const BRANCH_URL = process.env.SUPABASE_TEST_URL ?? "";
export const BRANCH_DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";
export const hasBranch = Boolean(BRANCH_URL && BRANCH_DB_URL);

function run(sql: string): string {
  try {
    return execFileSync("psql", [BRANCH_DB_URL, "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr ?? "";
    const wrapped = new Error(`psql failed: ${String(stderr)}`) as Error & { stderr?: Buffer | string };
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

/** Runs SQL as the branch owner and returns stdout, trimmed. Throws on a SQL error. */
export function psql(sql: string): string {
  if (!hasBranch) throw new Error("psql() needs SUPABASE_TEST_URL and SUPABASE_TEST_DB_URL");
  return run(sql).trim();
}

/** Runs SQL that must fail and returns the server's message. Throws when it succeeds. */
export function psqlExpectError(sql: string): string {
  try {
    run(sql);
  } catch (e) {
    return String((e as { stderr?: Buffer | string }).stderr ?? "");
  }
  throw new Error(`expected this SQL to fail: ${sql}`);
}

/** Delete only the calling suite's fixture namespace, including every dependent catalog row. */
export function resetCatalogFixtures(foodPrefix: string, versionPrefix: string): void {
  if (!/^test-[a-z0-9-]+$/.test(foodPrefix) || !/^test-[a-z0-9-]+$/.test(versionPrefix)) {
    throw new Error("Catalog cleanup requires test fixture prefixes");
  }
  const foods = `select id from catalog_foods where source = 'off' and source_id like '${foodPrefix}%'`;
  const revisions = `select id from catalog_food_revisions where catalog_food_id in (${foods})`;
  psql(`
    delete from food_refs where catalog_food_id in (${foods});
    delete from catalog_barcodes where catalog_food_id in (${foods});
    delete from catalog_ingredients where food_revision_id in (${revisions});
    delete from catalog_portions where food_revision_id in (${revisions});
    delete from catalog_food_nutrients where food_revision_id in (${revisions});
    delete from catalog_food_revisions where catalog_food_id in (${foods});
    delete from catalog_foods where id in (${foods});
    delete from catalog_versions where source = 'off' and version_label like '${versionPrefix}%'
      and not exists (select 1 from catalog_food_revisions r where r.catalog_version_id = catalog_versions.id);`);
}
