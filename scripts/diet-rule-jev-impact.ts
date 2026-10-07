/**
 * Phase 18 W2c (docs/specs/phase-18-open-world-foods.md D4, §10 W2c acceptance 3): the per-account
 * impact of taking Jev off the diet, religious and profile rules. READ-ONLY.
 *
 * For every account with Eats foods it judges each Eats food twice, on the same evidence the app
 * reads (lib/coach/suggest-policy.ts loadSuggestionEvidence, lib/coach/suggest-verdict.ts
 * suggestionPolicyEvidence): once with today's evaluatePolicy (no Jev facet decides a rule) and
 * once with the pre-W2c rule logic (scripts/diet-rule-jev-impact-legacy.ts). It prints counts only:
 * how many Eats foods (and how many of them starred Favorites) move from `allowed` to `unverified`,
 * and every other move. Account ids are a truncated SHA-256; no food name, food id or rule text is
 * printed.
 *
 *   pnpm exec tsx scripts/diet-rule-jev-impact.ts            one JSON line per account, then totals
 *
 * Env: the service-role pair lib/server/admin.ts reads. It takes no flag: there is
 * nothing to opt into, because it never writes. Every read goes through `readOnlyClient`, which
 * throws on insert, update, upsert, delete, rpc, storage, functions, realtime and auth, so a
 * write cannot happen even by mistake.
 */
import { hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import { suggestionFoodIdentity, suggestionPolicyEvidence } from "@/lib/coach/suggest-verdict";
import { evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { legacyVerdict } from "@/scripts/diet-rule-jev-impact-legacy";

type Verdict = "allowed" | "blocked" | "unverified";

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
const BLOCKED_CLIENT_KEYS = new Set(["rpc", "storage", "functions", "channel", "realtime",
  "removeChannel", "removeAllChannels", "auth", "schema"]);

/** Refuses every argument: the report has no mode, and no write mode to opt into. */
export function assertReportArgs(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new Error(`diet-rule-jev-impact is a read-only report and takes no arguments (got ${argv.join(" ")})`);
  }
}

function refuse(what: string): never {
  throw new Error(`diet-rule-jev-impact is read-only: ${what} is refused`);
}

const BUILDER_REFUSED = new Set([...WRITE_METHODS, "rpc"]);

/**
 * Wraps a query builder, and every builder or object any of its methods returns, so a write or
 * rpc is refused at any depth of a chain (an update after select and eq throws too).
 */
function readOnlyBuilder<T extends object>(builder: T, table: string): T {
  return new Proxy(builder, {
    get(inner, method, receiver) {
      if (typeof method === "string" && BUILDER_REFUSED.has(method)) refuse(`${table}.${method}`);
      const value = Reflect.get(inner, method, receiver);
      if (typeof value !== "function") return value;
      // `then`/`catch`/`finally` settle the query: their results are data, never a builder.
      if (method === "then" || method === "catch" || method === "finally") return value.bind(inner);
      return (...args: unknown[]) => {
        const result = value.apply(inner, args);
        return result !== null && typeof result === "object" ? readOnlyBuilder(result, table) : result;
      };
    },
  });
}

/** A client whose table builders refuse every write at any depth, with no rpc, storage or auth. */
export function readOnlyClient(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && BLOCKED_CLIENT_KEYS.has(prop)) refuse(`client.${prop}`);
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (table: string) => readOnlyBuilder(target.from(table), table);
    },
  });
}

/** A stable, non-reversible label for an account: the first 12 hex digits of SHA-256. */
export function accountLabel(userId: string): string {
  return hash("sha256", userId, "hex").slice(0, 12);
}

export type EatsItem = { foodRefId: string; catalogFoodRevisionId: number | null };

export type AccountImpact = {
  account: string;
  eatsFoods: number;
  favoredFoods: number;
  /** Eats foods with no own row or active catalog revision: judged neither before nor after. */
  unresolved: number;
  preferenceFlags: number;
  hardRules: number;
  allowedBefore: number;
  allowedAfter: number;
  allowedToUnverified: number;
  favoredAllowedToUnverified: number;
  allowedToBlocked: number;
  blockedToUnverified: number;
  unverifiedToAllowed: number;
  blockedToAllowed: number;
  evidenceUnavailable: boolean;
};

/** One account's counts from its Eats items and the evidence read for them. Pure. */
export function accountImpact(input: {
  userId: string; items: readonly EatsItem[]; unresolved: number; favored: ReadonlySet<string>;
  profile: ConstraintProfile; evidence: SuggestionEvidence;
}): AccountImpact {
  const counts: AccountImpact = {
    account: accountLabel(input.userId), eatsFoods: input.items.length + input.unresolved,
    favoredFoods: input.favored.size, unresolved: input.unresolved,
    preferenceFlags: input.evidence.preferenceFlags.length,
    hardRules: input.profile.profileRules?.items.length ?? 0,
    allowedBefore: 0, allowedAfter: 0, allowedToUnverified: 0, favoredAllowedToUnverified: 0,
    allowedToBlocked: 0, blockedToUnverified: 0, unverifiedToAllowed: 0, blockedToAllowed: 0,
    evidenceUnavailable: input.evidence.status !== "ready",
  };
  if (counts.evidenceUnavailable) return counts;
  for (const item of input.items) {
    const facts = input.evidence.byIdentity[suggestionFoodIdentity(item)];
    const e = suggestionPolicyEvidence(item.foodRefId, facts, input.evidence.preferenceFlags,
      input.profile);
    const before: Verdict = legacyVerdict(input.profile, e);
    const after: Verdict = evaluatePolicy(input.profile, e).verdict;
    if (before === "allowed") counts.allowedBefore += 1;
    if (after === "allowed") counts.allowedAfter += 1;
    if (before === "allowed" && after === "unverified") {
      counts.allowedToUnverified += 1;
      if (input.favored.has(item.foodRefId)) counts.favoredAllowedToUnverified += 1;
    }
    if (before === "allowed" && after === "blocked") counts.allowedToBlocked += 1;
    if (before === "blocked" && after === "unverified") counts.blockedToUnverified += 1;
    if (before === "unverified" && after === "allowed") counts.unverifiedToAllowed += 1;
    if (before === "blocked" && after === "allowed") counts.blockedToAllowed += 1;
  }
  return counts;
}

const SUMMED = ["eatsFoods", "favoredFoods", "unresolved", "allowedBefore", "allowedAfter",
  "allowedToUnverified", "favoredAllowedToUnverified", "allowedToBlocked", "blockedToUnverified",
  "unverifiedToAllowed", "blockedToAllowed"] as const;

/** Totals over every account, plus how many accounts lose at least one allowed Eats food. Pure. */
export function impactTotals(rows: readonly AccountImpact[]) {
  const totals = Object.fromEntries(SUMMED.map((key) =>
    [key, rows.reduce((sum, row) => sum + row[key], 0)])) as Record<(typeof SUMMED)[number], number>;
  return { accounts: rows.length,
    accountsLosingAllowedFoods: rows.filter((row) => row.allowedToUnverified > 0).length,
    accountsEvidenceUnavailable: rows.filter((row) => row.evidenceUnavailable).length, ...totals };
}

/** The I/O the report needs; every one of them reads only. */
export type ImpactPorts = {
  accounts: () => Promise<string[]>;
  eatsItems: (userId: string) => Promise<{ items: EatsItem[]; unresolved: number }>;
  favored: (userId: string) => Promise<Set<string>>;
  profile: (userId: string) => Promise<ConstraintProfile>;
  evidence: (userId: string, items: readonly EatsItem[], profile: ConstraintProfile) =>
    Promise<SuggestionEvidence>;
};

export async function runReport(ports: ImpactPorts, print: (line: string) => void): Promise<void> {
  const rows: AccountImpact[] = [];
  for (const userId of await ports.accounts()) {
    const [{ items, unresolved }, favored, profile] = await Promise.all([
      ports.eatsItems(userId), ports.favored(userId), ports.profile(userId)]);
    if (items.length + unresolved === 0) continue;
    const evidence = await ports.evidence(userId, items, profile);
    const eatsRefs = new Set(items.map((item) => item.foodRefId));
    const row = accountImpact({ userId, items, unresolved, profile, evidence,
      favored: new Set([...favored].filter((id) => eatsRefs.has(id))) });
    rows.push(row);
    print(JSON.stringify(row));
  }
  print(JSON.stringify({ totals: impactTotals(rows) }));
}

type RefRow = { id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null;
  user_foods: { id: string; user_id: string } | { id: string; user_id: string }[] | null };

/** The production ports, all through `readOnlyClient`. */
export function databasePorts(client: SupabaseClient): ImpactPorts {
  const db = readOnlyClient(client);
  return {
    accounts: async () => {
      const { fetchAllRows } = await import("@/lib/server/paged-read");
      const rows = await fetchAllRows<{ user_id: string }>((from, to) => db.from("user_settings")
        .select("user_id").order("user_id").range(from, to));
      return [...new Set(rows.map((row) => row.user_id))];
    },
    eatsItems: async (userId) => {
      const { fetchAllRows, fetchAllChunked } = await import("@/lib/server/paged-read");
      const prefs = await fetchAllRows<{ food_ref_id: string }>((from, to) => db
        .from("user_food_prefs").select("food_ref_id").eq("user_id", userId).eq("status", "eats")
        .order("food_ref_id").range(from, to));
      const refIds = [...new Set(prefs.map((row) => row.food_ref_id))];
      const refs = await fetchAllChunked<string, RefRow>(refIds, (chunk, from, to) => db
        .from("food_refs").select("id,kind,catalog_food_id,user_food_id,user_foods(id,user_id)")
        .in("id", chunk).order("id").range(from, to));
      const catalogIds = [...new Set(refs.filter((ref) => ref.kind === "catalog")
        .map((ref) => ref.catalog_food_id).filter((id): id is number => id !== null))];
      const revisions = await fetchAllChunked<number, { id: number; catalog_food_id: number }>(
        catalogIds, (chunk, from, to) => db.from("catalog_food_revisions").select("id,catalog_food_id")
          .in("catalog_food_id", chunk).eq("is_active", true).order("id").range(from, to));
      const active = new Map(revisions.map((row) => [row.catalog_food_id, row.id]));
      const items = refs.flatMap((ref): EatsItem[] => {
        const own = Array.isArray(ref.user_foods) ? ref.user_foods[0] : ref.user_foods;
        if (ref.kind === "user") {
          return own?.user_id === userId && own.id === ref.user_food_id
            ? [{ foodRefId: ref.id, catalogFoodRevisionId: null }] : [];
        }
        const revision = ref.catalog_food_id === null ? undefined : active.get(ref.catalog_food_id);
        return revision === undefined ? [] : [{ foodRefId: ref.id, catalogFoodRevisionId: revision }];
      });
      return { items, unresolved: refIds.length - items.length };
    },
    favored: async (userId) => {
      const { fetchAllRows } = await import("@/lib/server/paged-read");
      const rows = await fetchAllRows<{ food_ref_id: string }>((from, to) => db.from("favorites_foods")
        .select("food_ref_id").eq("user_id", userId).is("deleted_at", null).order("food_ref_id")
        .range(from, to));
      return new Set(rows.map((row) => row.food_ref_id));
    },
    profile: async (userId) => {
      const { readPolicyProfile } = await import("@/lib/server/policy-profile");
      return (await readPolicyProfile(db, userId, new Date())).profile;
    },
    evidence: async (userId, items, profile) => {
      const { loadSuggestionEvidence } = await import("@/lib/coach/suggest-policy");
      return loadSuggestionEvidence(userId, items, { needsNoCook: false, client: db,
        facets: profileRuleFacets(profile.profileRules) });
    },
  };
}

export async function main(argv: string[]): Promise<void> {
  assertReportArgs(argv);
  const { adminClient } = await import("@/lib/server/admin");
  await runReport(databasePorts(adminClient()), (line) => console.log(line));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
