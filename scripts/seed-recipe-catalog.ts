/** Reviewed pilot seed. Default is offline; --preflight reads only; --write changes the selected DB. */
import { pathToFileURL } from "node:url";
import { adminClientForSeedTarget } from "@/lib/server/admin";
import { pilotManifest, preflightPilotCatalog, seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";

export type SeedTarget = { url: string; mode: "local" | "production" };
type SeedEnvironment = Record<string, string | undefined>;

/** Validate target and confirmation before creating a client or making a request. */
export function resolveSeedTarget(args: string[], env: SeedEnvironment): SeedTarget {
  const production = args.includes("--production");
  const allowed = new Set(["--production", "--write", "--preflight", "--dry-run"]);
  if (args.some((arg) => !allowed.has(arg) && !arg.startsWith("--confirm-project-ref="))) {
    throw new Error("Unknown seed option");
  }
  const url = production ? env.SUPABASE_URL : env.SUPABASE_TEST_URL;
  if (!url) throw new Error(production
    ? "Production Supabase URL is missing"
    : "Local test Supabase URL is missing");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Configured Supabase URL is invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Configured Supabase URL must be a bare origin");
  }
  if (!production) {
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("Local seed target must use a loopback SUPABASE_TEST_URL");
    }
    if (args.some((arg) => arg.startsWith("--confirm-project-ref="))) {
      throw new Error("Project-ref confirmation is only for --production");
    }
    return { url: parsed.origin, mode: "local" };
  }
  const confirmations = args.filter((arg) => arg.startsWith("--confirm-project-ref="));
  const expected = env.SUPABASE_PROJECT_REF;
  const confirmed = confirmations[0]?.slice("--confirm-project-ref=".length);
  if (parsed.protocol !== "https:" || parsed.port || !expected
    || !/^[a-z0-9]{15,30}$/.test(expected)
    || confirmations.length !== 1 || confirmed !== expected
    || parsed.hostname !== `${expected}.supabase.co`) {
    throw new Error("Production target requires one exact --confirm-project-ref matching SUPABASE_PROJECT_REF and SUPABASE_URL origin");
  }
  return { url: parsed.origin, mode: "production" };
}

export async function runSeed(args: string[], env: SeedEnvironment): Promise<string> {
  const manifest = pilotManifest();
  const summary = `Original pilot manifest: ${manifest.recipes} recipes, ${manifest.ingredientLines} ingredient lines, ${manifest.foodDbIds} FoodDB IDs, ${manifest.steps} steps; original rights, source revision and estimated nutrition checked.`;
  if (!args.includes("--write") && !args.includes("--preflight") && !args.includes("--dry-run")) {
    if (args.length) throw new Error("Pass --preflight/--dry-run to read the catalog or --write to seed it");
    return `${summary}\nNo database request made. Pass --preflight for a read-only check.`;
  }
  if (args.includes("--write") && (args.includes("--preflight") || args.includes("--dry-run"))) {
    throw new Error("Choose either --write or --preflight/--dry-run");
  }
  const target = resolveSeedTarget(args, env);
  const client = adminClientForSeedTarget(target, env);
  const preflight = await preflightPilotCatalog(client);
  if (!args.includes("--write")) {
    return `${summary}\nRead-only ${target.mode} preflight: ${preflight.toCreate} to create, ${preflight.skipped} existing; no writes.`;
  }
  const result = await seedPilotCatalog(client);
  return `${summary}\n${target.mode} seed: created ${result.created}, skipped ${result.skipped}.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed(process.argv.slice(2), process.env).then((message) => {
    process.stdout.write(`${message}\n`);
  }).catch((error) => {
    process.stderr.write(`Recipe pilot seed failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
