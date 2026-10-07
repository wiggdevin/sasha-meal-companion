/**
 * CLI path for the same issue flow (spec §7), for when the UI is not available:
 *   pnpm exec tsx scripts/issue-health-token.ts <user_id> <kind> [device_label]
 * Prints the plaintext token once. Nothing stores it.
 */
import { adminClient } from "@/lib/server/admin";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { toBytea } from "@/lib/server/tokens";

const KINDS = new Set(["health_auto_export", "apple_health_shortcut", "manual"]);

async function main(): Promise<void> {
  const [userId, kind, deviceLabel] = process.argv.slice(2);
  if (!userId || !KINDS.has(kind ?? "")) {
    throw new Error("usage: issue-health-token.ts <user_id> <health_auto_export|apple_health_shortcut|manual> [device_label]");
  }
  const admin = adminClient();
  const { raw, hash } = issueSourceToken();
  const { data, error } = await admin.from("health_sources")
    .insert({ user_id: userId, kind, device_label: deviceLabel ?? null, token_hash: toBytea(hash) })
    .select("id").single();
  if (error) throw error;

  console.log(`source ${data.id}\ntoken  ${raw}\n\nPaste the token into the Authorization header now; it is not stored.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
