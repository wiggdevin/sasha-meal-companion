/**
 * Mint one personal access token for an explicit account id and print it once.
 *
 *   pnpm exec tsx scripts/mint-token.ts --user-id <uuid> "Codex CLI" read
 *   (needs the Supabase URL and service-role key named in .env.example)
 *
 * Only the SHA-256 hash reaches the database. The raw token is shown once and
 * never again — put it in ZS Vault straight away.
 */

import { adminClient } from "@/lib/server/admin";
import { mintToken, toBytea } from "@/lib/server/tokens";

const ALLOWED_SCOPES = new Set(["read", "log:write", "constraints:write"]);

async function main(): Promise<void> {
  const [flag, userId, label, ...scopes] = process.argv.slice(2);
  if (flag !== "--user-id" || !userId || !label) {
    console.error('usage: mint-token.ts --user-id <uuid> "<label>" [read] [log:write] [constraints:write]');
    process.exit(1);
  }

  const wanted = scopes.length > 0 ? scopes : ["read"];
  for (const scope of wanted) {
    if (!ALLOWED_SCOPES.has(scope)) {
      console.error(`Unknown scope "${scope}". Use read, log:write or constraints:write.`);
      process.exit(1);
    }
  }

  const { raw, hash } = mintToken();
  const { data, error } = await adminClient()
    .from("api_tokens")
    .insert({ label, user_id: userId, token_hash: toBytea(hash), scopes: wanted })
    .select("id")
    .single();

  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`token id: ${data.id}`);
  console.log(`label:    ${label}`);
  console.log(`scopes:   ${wanted.join(" ")}`);
  console.log(`token:    ${raw}`);
  console.log("Shown once. Store it now; the database holds only the hash.");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
