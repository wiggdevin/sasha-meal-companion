/**
 * Re-seal every stored Oura token pair under a new HEALTH_TOKEN_KEY (W080). Runbook:
 * docs/operations/reseal-health-tokens.md.
 *
 *   OLD_HEALTH_TOKEN_KEY=<b64> NEW_HEALTH_TOKEN_KEY=<b64> pnpm exec tsx scripts/reseal-health-tokens.ts
 *       dry run (the default): reads, opens and counts; writes nothing
 *   ... --commit                    write on a branch or local database
 *   ... --commit --production       write on production: a deliberate, owner-approved step
 *
 * Each row is updated with a compare-and-swap on the sealed value it read, so a token the app
 * rotated meanwhile is never overwritten (it is counted `raced` and picked up by a second run).
 * A value that already opens under the new key is skipped, so a stopped run can be repeated.
 * Neither key nor any token is ever printed. The write guard is the one the other repair scripts
 * use (`assertWriteTarget`): `--commit` refuses production without `--production`.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { resealOauth } from "@/lib/server/health-tokens";
import { assertWriteTarget } from "./food-membership-audit";

export type Args = { commit: boolean; production: boolean };
export type Tally = { total: number; resealed: number; alreadyNew: number; raced: number; failed: number };

export function parseArgs(argv: readonly string[]): Args {
  const allowed = new Set(["--commit", "--production"]);
  for (const a of argv) if (!allowed.has(a)) throw new Error(`unknown argument ${a}`);
  return { commit: argv.includes("--commit"), production: argv.includes("--production") };
}

/** Maps this script's flags onto the shared guard (`--commit` is its `--fix`). */
export function guardFlags(args: Args): string[] {
  return [...(args.commit ? ["--fix"] : []), ...(args.production ? ["--production"] : [])];
}

export function keyFromEnv(name: string, env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env[name];
  if (!raw) throw new Error(`${name} not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return key;
}

const PAGE = 200;

export async function reseal(admin: SupabaseClient, oldKey: Buffer, newKey: Buffer,
    commit: boolean): Promise<Tally> {
  const tally: Tally = { total: 0, resealed: 0, alreadyNew: 0, raced: 0, failed: 0 };
  let last = "";
  for (;;) {
    const { data, error } = await admin.from("health_sources").select("id, oauth")
      .not("oauth", "is", null).gt("id", last).order("id").limit(PAGE);
    if (error) throw new Error(`read failed: ${error.code ?? "error"}`);
    const rows = (data ?? []) as { id: string; oauth: string }[];
    if (rows.length === 0) return tally;
    for (const row of rows) {
      last = row.id;
      tally.total += 1;
      let next;
      try { next = resealOauth(row.oauth, oldKey, newKey); } catch { tally.failed += 1; continue; }
      if (!next.changed) { tally.alreadyNew += 1; continue; }
      if (!commit) { tally.resealed += 1; continue; }
      const { data: updated, error: writeError } = await admin.from("health_sources")
        .update({ oauth: next.sealed }).eq("id", row.id).eq("oauth", row.oauth).select("id");
      if (writeError) { tally.failed += 1; continue; }
      if (Array.isArray(updated) && updated.length > 0) tally.resealed += 1;
      else tally.raced += 1;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertWriteTarget(guardFlags(args), process.env.SUPABASE_URL);
  const oldKey = keyFromEnv("OLD_HEALTH_TOKEN_KEY");
  const newKey = keyFromEnv("NEW_HEALTH_TOKEN_KEY");
  if (oldKey.equals(newKey)) throw new Error("old and new keys are the same");
  const tally = await reseal(adminClient(), oldKey, newKey, args.commit);
  console.log(`${args.commit ? "committed" : "dry run"}: ${JSON.stringify(tally)}`);
  if (tally.failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
