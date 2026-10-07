/**
 * Re-derive one account's active target revision from its stored profile, through the same
 * server service the sync path uses (`lib/server/target-recompute.ts`), never hand SQL.
 *
 *   --user-id <uuid>                    read-only: print the active revision and what would be written
 *   --user-id <uuid> --fix              write on a branch or local database
 *   --user-id <uuid> --fix --production write on production: a deliberate, owner-approved step
 *   --date YYYY-MM-DD                   effective date (default: today in the account's time zone)
 *
 * The write guard is the one `scripts/food-membership-audit.ts` uses: `--fix` refuses production
 * without `--production`, and refuses outright when SUPABASE_URL names no identifiable project.
 * The new revision takes effect on the given date; earlier revisions are history and stay as they are.
 */
import { fileURLToPath } from "node:url";
import type { TargetProfile } from "@/lib/api-types";
import type { TargetRevision } from "@/lib/types";
import { adminClient } from "@/lib/server/admin";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";
import { assertWriteTarget } from "./food-membership-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Args = { userId: string; date?: string; fix: boolean; production: boolean };

export function parseArgs(argv: readonly string[]): Args {
  let userId: string | undefined;
  let date: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id" || arg === "--date") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg === "--user-id") userId = value;
      else date = value;
    }
    else if (arg === "--fix" || arg === "--production") flags.add(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!userId || !UUID.test(userId)) throw new Error("--user-id <uuid> is required");
  const parsed = date === undefined ? null : new Date(`${date}T12:00:00Z`);
  if (date !== undefined && (!DATE.test(date) || Number.isNaN(parsed!.getTime())
    || parsed!.toISOString().slice(0, 10) !== date)) {
    throw new Error("--date must be a real YYYY-MM-DD date");
  }
  return { userId, date, fix: flags.has("--fix"), production: flags.has("--production") };
}

function activeLine(active: TargetProfile | null): string {
  if (!active) return "active: none";
  return `active: rev ${active.rev} from ${active.effective_from}, training ${active.kcal_train} kcal, `
    + `rest ${active.kcal_rest} kcal, kcal_min ${active.kcal_min} (${active.kcal_min_source ?? "?"}), `
    + `weight ${active.input_weight_kg ?? "?"} kg (${active.input_weight_source ?? "?"}), `
    + `formula ${active.formula_name ?? "none"}`;
}

function revisionLine(label: string, revision: TargetRevision): string {
  const floors = (revision as TargetRevision & { floors?: { kcalMin: number; kcalMinSource: string } })
    .floors;
  return `${label}: from ${revision.effectiveFrom}, training ${revision.training.kcal} kcal `
    + `(P${revision.training.protein} C${revision.training.carbs} F${revision.training.fat}), `
    + `rest ${revision.rest.kcal} kcal (P${revision.rest.protein} C${revision.rest.carbs} F${revision.rest.fat})`
    + (floors ? `, kcal_min ${floors.kcalMin} (${floors.kcalMinSource})` : "")
    + `, weight ${revision.inputs.weightKg} kg (${revision.inputs.weightSource})`;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // Before any client exists: a refused run opens no connection at all.
  // The URL adminClient() will connect to (SUPABASE_URL, else SUPABASE_TEST_URL), so the guard and
  // the client always judge the same project.
  assertWriteTarget(argv.filter((arg) => arg === "--fix" || arg === "--production"),
    process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL);
  const admin = adminClient();
  const outcome = await recomputeDerivedTarget(admin, args.userId,
    { today: args.date, dryRun: !args.fix });
  console.log(`user ${args.userId}`);
  if (outcome.status !== "written") console.log(activeLine(outcome.active));
  else console.log(`now ${activeLine(outcome.active)}`);
  switch (outcome.status) {
    case "skipped":
      console.log(`skipped: ${outcome.reason}`);
      return;
    case "unchanged":
      console.log(revisionLine("expected", outcome.expected));
      console.log("unchanged: the active revision already matches the stored profile");
      return;
    case "would_write":
      console.log(revisionLine("would write", outcome.expected));
      console.log("read-only: pass --fix (and --production on production) to write it");
      return;
    case "unsettled":
      throw new Error(`the profile or active revision kept changing for ${outcome.rounds} rounds; rerun`);
    case "written": {
      console.log(revisionLine(`written (rev ${outcome.revision.revision})`, outcome.revision));
      const check = await recomputeDerivedTarget(admin, args.userId, { today: args.date, dryRun: true });
      if (check.status !== "unchanged") throw new Error(`after write the target is ${check.status}`);
      console.log("verified: the active revision now matches the stored profile");
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
