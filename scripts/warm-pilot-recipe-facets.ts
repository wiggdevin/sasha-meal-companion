/** Warm only the 30 reviewed public USDA foods used by the original recipe pilot. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reviewedPilotFoodDbIds } from "@/lib/recipe-catalog/pilot-sr-legacy";
import { resolvePilotCatalogRevisions } from "@/lib/server/recipe-pilot-identity";
import { adminClientForSeedTarget } from "@/lib/server/admin";
import { resolveSeedTarget } from "./seed-recipe-catalog";

const CHILD = "--pilot-facet-react-server-child";

export function warmOptions(args: string[], env: Record<string, string | undefined>) {
  const publicArgs = args.filter((arg) => arg !== CHILD);
  if (publicArgs.some((arg) => !["--production", "--commit", "--dry-run"].includes(arg)
    && !arg.startsWith("--confirm-project-ref=") && !arg.startsWith("--user-id="))
    || (publicArgs.includes("--commit") && publicArgs.includes("--dry-run"))) {
    throw new Error("Use --dry-run (default) or --commit with an explicit target");
  }
  const commit = publicArgs.includes("--commit");
  const suppliedUserId = publicArgs.find((arg) => arg.startsWith("--user-id="))?.slice(10);
  const userId = suppliedUserId
    ?? env.FACET_WARM_USER_ID ?? env.SUPABASE_TEST_USER_ID;
  const target = resolveSeedTarget([
    ...publicArgs.filter((arg) => arg === "--production" || arg.startsWith("--confirm-project-ref=")),
    commit ? "--write" : "--dry-run",
  ], env);
  if (commit && (!userId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)
    || (target.mode === "production" && !suppliedUserId))) {
    throw new Error("--commit requires an accounting --user-id UUID; production requires the explicit flag");
  }
  return { commit, userId, target };
}

export async function runPilotWarm(args: string[], env: Record<string, string | undefined>,
  deps?: { client?: SupabaseClient; warm?: (ids: readonly number[], options: {
    admin: SupabaseClient; userId?: string; dryRun: boolean;
  }) => Promise<{ foods: number; judged: number; skipped: number; unknown: number;
    writes: number; errors: number; retryableUnknown: number }> }) {
  const options = warmOptions(args, env);
  const client = deps?.client ?? adminClientForSeedTarget(options.target, env);
  const reviewed = reviewedPilotFoodDbIds();
  const mapped = await resolvePilotCatalogRevisions(client, reviewed);
  const missing = reviewed.filter((id) => !mapped.has(id));
  if (missing.length) {
    if (options.commit) throw new Error(`Pilot catalog incomplete: ${missing.join(", ")}`);
    return { target: options.target.mode, mapped: mapped.size, missing, dryRun: true,
      facets: null, writes: 0 };
  }
  // Load the existing warmer only after target validation. It supplies canonical input hashes,
  // shared spend accounting, cache reuse and conservative allergen evidence recording.
  const warm = deps?.warm ?? (await import("@/lib/foods/facet-warm")).ensureCatalogRevisionFacets;
  const ids = [...new Set([...mapped.values()].map((identity) => identity.revisionId))];
  const facets = await warm(ids, { admin: client, userId: options.userId,
    dryRun: !options.commit });
  if (facets.errors > 0 || (options.commit && facets.retryableUnknown > 0)) {
    throw new Error(`Pilot facet warm incomplete: ${facets.errors} error(s), `
      + `${facets.retryableUnknown} retryable unknown(s); inspect cache before retry`);
  }
  return { target: options.target.mode, mapped: mapped.size, missing, dryRun: !options.commit,
    facets, writes: facets.writes };
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (direct && !process.argv.includes(CHILD)) {
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD, ...process.argv.slice(2)], {
    stdio: "inherit", env: process.env,
  });
  if (child.error) console.error(child.error.message);
  process.exitCode = child.status ?? 1;
} else if (direct) runPilotWarm(process.argv.slice(2), process.env).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
