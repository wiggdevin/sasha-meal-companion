/**
 * The one-tap "Favor" on an "Eaten often" row (Phase 18 D6, D13): `POST /api/foods/favor`, and the
 * `favorable` flag `GET /api/foods/taste` shows for it. Both run the one plan below.
 *
 * Plan (`planFavor`), per key:
 * 1. The item's refs: `favorKeyRefs`, exactly the refs the taste route judges for the identity.
 * 2. Each ref's name family, and each family's FULL write set: the refs `set_food_membership`
 *    would write (`favor_family_sets`, migration 20261215090000), not only the item's refs.
 * 3. Every member judged with the W3 admission verdicts (`tasteJudge`); family marks read through
 *    the owner-filtered service-role reader (the session client cannot see them).
 * 4. A family is `avoid` when any member is on Avoid, the family is avoided by name or carries an
 *    Avoid mark; `blocked` when any member is not `allowed`; `eats` when already marked; else `ok`.
 *    The key is avoided outright when its own family is.
 * `favorable` = the key is not avoided and at least one family is `ok` or `eats`.
 *
 * POST: the key must be one of the caller's own current taste items for the same window (else 404),
 * the account rules and evidence versions are captured BEFORE the taste and policy reads, and the
 * `ok`/`eats` families go to `favor_food_families` in ONE call: it locks, re-checks the versions,
 * the exact ref sets, Avoid and the judged allowed ids, and writes all or nothing. Drift answers
 * 409 `rules_changed`; nothing favorable answers 422.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { HttpError } from "@/lib/server/auth";
import { readByIdBatches } from "@/lib/server/date-chunks";
import {
  readFamilySets, readMembershipRevisions, writeFavorFamilies, type FamilySets, type FavorWriter,
  type MembershipReader,
} from "@/lib/server/membership-revisions";
import { readRulesToken } from "@/lib/server/rules-clock";
import {
  computeTaste, DEFAULT_TASTE_PORTS, favorKeyRefs, tasteJudge, type FavorableKeys, type TastePorts,
} from "@/lib/server/taste-admission";
import type { TasteHistory } from "@/lib/server/taste-history";

export const FAVOR_KEY_MAX = 160;

export type FavorResponse = { favored: true; refs: number; skippedAvoid: number; rulesRevision: number };

export type FavorPorts = {
  taste: TastePorts;
  memberships: MembershipReader;
  familySets: FamilySets;
  write: FavorWriter;
  /** The account rules and global evidence versions (`GET /api/foods/rules-version`). */
  clock: (client: SupabaseClient, userId: string) => Promise<{ rulesVersion: number; evidenceVersion: number }>;
};

export const DEFAULT_FAVOR_PORTS: FavorPorts = {
  taste: DEFAULT_TASTE_PORTS,
  memberships: readMembershipRevisions,
  familySets: readFamilySets,
  write: writeFavorFamilies,
  clock: readRulesToken,
};

/** 409 `rules_changed`: the account's rules or foods moved after the judgement; nothing was written. */
export class RulesChangedError extends HttpError {
  constructor(public rulesVersion: number) {
    super(409, "rules_changed", "Your food rules or foods changed. Try again.");
  }
}

/** A taste identity key, or null for anything malformed. */
export function parseTasteKey(key: unknown): { kind: "u"; id: string } | { kind: "f"; family: string } | null {
  if (typeof key !== "string" || key.length > FAVOR_KEY_MAX) return null;
  if (key.startsWith("u:")) return universeEntry(key.slice(2)) ? { kind: "u", id: key.slice(2) } : null;
  if (key.startsWith("f:")) {
    const family = key.slice(2);
    return family && baseFoodName(family) === family ? { kind: "f", family } : null;
  }
  return null;
}

/** The family the key itself names: the `f:` family, or the universe item's name family. */
function keyFamily(key: string): string | null {
  const parsed = parseTasteKey(key);
  if (!parsed) return null;
  return (parsed.kind === "f" ? parsed.family : baseFoodName(dbFood(parsed.id)?.name ?? "")) || null;
}

const unknownKey = () => new HttpError(404, "unknown_key", "That food is not in your eaten history.");
const nothingToFavor = () => new HttpError(422, "nothing_to_favor",
  "That food is on your Avoid list or blocked by your food rules.");

async function select<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
  return (data ?? []) as T[];
}

/** Each ref's name family, read by owner for account foods; a ref with no readable name maps to null. */
async function refFamilies(client: SupabaseClient, userId: string, refIds: string[]): Promise<Map<string, string | null>> {
  const refs = await readByIdBatches(refIds, (batch) => select<{ id: string; kind: string;
    catalog_food_id: number | null; user_food_id: string | null }>(client.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id").in("id", batch)));
  const own = await readByIdBatches(refs.flatMap((ref) => ref.kind === "user" && ref.user_food_id ? [ref.user_food_id] : []),
    (batch) => select<{ id: string; name: string }>(client.from("user_foods").select("id,name")
      .eq("user_id", userId).is("deleted_at", null).in("id", batch)));
  const catalog = await readByIdBatches(refs.flatMap((ref) => ref.kind === "catalog" && ref.catalog_food_id !== null
    ? [Number(ref.catalog_food_id)] : []), (batch) => select<{ catalog_food_id: number; description: string }>(
    client.from("catalog_food_revisions").select("catalog_food_id,description").in("catalog_food_id", batch)
      .eq("is_active", true)));
  const ownName = new Map(own.map((row) => [row.id, row.name]));
  const catalogName = new Map(catalog.map((row) => [Number(row.catalog_food_id), row.description]));
  const out = new Map<string, string | null>(refIds.map((id) => [id, null]));
  for (const ref of refs) {
    const name = ref.kind === "user" ? ownName.get(ref.user_food_id ?? "")
      : ref.kind === "catalog" && ref.catalog_food_id !== null ? catalogName.get(Number(ref.catalog_food_id)) : undefined;
    out.set(ref.id, (name ? baseFoodName(name) : "") || null);
  }
  return out;
}

export type FamilyVerdict = "ok" | "eats" | "avoid" | "blocked";

export type KeyPlan = {
  key: string;
  keyFamily: string | null;
  /** The item's refs (`favorKeyRefs`) and the family each belongs to (null: no readable name). */
  refs: string[];
  refFamily: Map<string, string | null>;
  keyAvoided: boolean;
  /** Each family of the item's refs: its full write set and verdict. */
  families: Map<string, { refIds: string[]; verdict: FamilyVerdict }>;
  favorable: boolean;
};

/** The shared Favor plan for `keys` under one read of rules, Avoid, marks and family sets. */
export async function planFavor(
  client: SupabaseClient, userId: string, history: TasteHistory, keys: string[], ports: FavorPorts, now: Date,
): Promise<{ plans: Map<string, KeyPlan>; rulesRevision: number }> {
  const refsByKey = new Map(keys.map((key) => [key, favorKeyRefs(history, key)]));
  const allRefs = [...new Set([...refsByKey.values()].flat())].sort();
  const refFamily = await refFamilies(client, userId, allRefs);
  const families = [...new Set([...refFamily.values()].filter((family): family is string => family !== null))].sort();
  const sets = families.length ? await ports.familySets(userId, families) : new Map<string, string[]>();
  const members = [...new Set([...allRefs, ...[...sets.values()].flat()])].sort();
  const judge = await tasteJudge(client, userId, history, members, now, ports.taste);
  if (!judge.evidenceReady) {
    throw new HttpError(503, "admission_unavailable", "Your food rules could not be checked right now.");
  }
  const keyFamilies = keys.map(keyFamily).filter((family): family is string => family !== null);
  const marks = await ports.memberships(userId, [...new Set([...families, ...keyFamilies])]);
  const avoidedName = (family: string) => judge.avoidFamilies.has(family) || marks.get(family)?.status === "avoid";
  const verdicts = new Map(families.map((family) => {
    const set = sets.get(family) ?? [];
    const verdict: FamilyVerdict = avoidedName(family) || set.some(judge.refAvoided) ? "avoid"
      : set.length === 0 || !set.every(judge.refAllowed) ? "blocked"
        : marks.get(family)?.status === "eats" ? "eats" : "ok";
    return [family, { refIds: set, verdict }];
  }));
  const plans = new Map<string, KeyPlan>();
  for (const key of keys) {
    const refs = refsByKey.get(key) ?? [];
    const own = keyFamily(key);
    const keyAvoided = !judge.familyOk(key) || (own !== null && avoidedName(own));
    const mine = new Map([...new Set(refs.map((ref) => refFamily.get(ref) ?? null))]
      .flatMap((family) => family !== null && verdicts.has(family) ? [[family, verdicts.get(family)!] as const] : []));
    const favorable = !keyAvoided && [...mine.values()].some(({ verdict }) => verdict === "ok" || verdict === "eats");
    plans.set(key, { key, keyFamily: own, refs, refFamily, keyAvoided, families: mine, favorable });
  }
  return { plans, rulesRevision: judge.rulesRevision };
}

/** `favorable` for `GET /api/foods/taste`, from the same plan the Favor write uses. */
export function favorableResolver(client: SupabaseClient, userId: string, ports: FavorPorts = DEFAULT_FAVOR_PORTS,
  now: Date = new Date()): FavorableKeys {
  return async (history, keys) => {
    const withRefs = keys.filter((key) => favorKeyRefs(history, key).length > 0);
    if (!withRefs.length) return new Set();
    const { plans } = await planFavor(client, userId, history, withRefs, ports, now);
    return new Set([...plans.values()].filter((plan) => plan.favorable).map((plan) => plan.key));
  };
}

/** Favor one taste identity for `userId` on `today` (the taste window's last day). */
export async function favorTasteKey(
  client: SupabaseClient, userId: string, key: unknown, today: string,
  ports: FavorPorts = DEFAULT_FAVOR_PORTS, now: Date = new Date(),
): Promise<FavorResponse> {
  if (!parseTasteKey(key)) throw unknownKey();
  const identity = key as string;
  // Captured before every taste and policy read; the write re-checks them under its locks.
  const token = await ports.clock(client, userId);
  const { history, response } = await computeTaste(client, userId, today, ports.taste, now);
  if (!response.items.some((item) => item.key === identity) || !favorKeyRefs(history, identity).length) {
    throw unknownKey();
  }
  const { plans, rulesRevision } = await planFavor(client, userId, history, [identity], ports, now);
  const plan = plans.get(identity)!;
  const verdictOf = (ref: string) => {
    const family = plan.refFamily.get(ref) ?? null;
    return family === null ? "blocked" : plan.families.get(family)?.verdict ?? "blocked";
  };
  const skippedAvoid = plan.keyAvoided ? plan.refs.length : plan.refs.filter((ref) => verdictOf(ref) === "avoid").length;
  const candidates = plan.keyAvoided ? [] : [...plan.families].filter(([, f]) => f.verdict === "ok" || f.verdict === "eats");
  if (!candidates.length) throw nothingToFavor();
  const outcome = await ports.write(userId, {
    keyFamily: plan.keyFamily,
    families: candidates.map(([family, f]) => ({ name_norm: family, ref_ids: f.refIds })),
    allowed: [...new Set(candidates.flatMap(([, f]) => f.refIds))].sort(),
    rulesVersion: token.rulesVersion, evidenceVersion: token.evidenceVersion,
  });
  switch (outcome.status) {
    case "ok": {
      const favored = new Set(outcome.favored);
      const refs = plan.refs.filter((ref) => favored.has(plan.refFamily.get(ref) ?? "")).length;
      return { favored: true, refs, skippedAvoid, rulesRevision };
    }
    case "avoid":
      throw nothingToFavor();
    case "rules_changed":
      throw new RulesChangedError(outcome.rulesVersion);
    default:
      // A family's write set or a member's verdict moved after the plan: the same as a rules change.
      throw new RulesChangedError((await ports.clock(client, userId)).rulesVersion);
  }
}
