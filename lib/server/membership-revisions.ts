import "server-only";
/**
 * The Favor path's service-role reads and write (Phase 18 D6, lib/server/taste-favor.ts), always
 * for the session user's id, never a value from the request body:
 * - the caller's family membership marks, with the explicit `user_id` filter (the declared read;
 *   since W029 the owner may also read them through RLS, migration 20261231110000);
 * - `favor_family_sets` and `favor_food_families` (migration 20261215090000), executable by
 *   service_role only, which take the owner as their first argument.
 * Tenancy canary: tests/tenancy/admin-favor.test.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { readByIdBatches } from "@/lib/server/date-chunks";

export type MembershipMark = { name_norm: string; status: "eats" | "avoid" | null; rev: number };

export type MembershipReader = (userId: string, names: string[]) => Promise<Map<string, MembershipMark>>;

/** Reads `names` for `userId` on `client`, with the explicit owner filter. */
export function membershipReader(client: () => SupabaseClient): MembershipReader {
  return async (userId, names) => {
    const rows = await readByIdBatches([...new Set(names)], async (batch) => {
      const { data, error } = await client().from("food_membership_revisions").select("name_norm,status,rev")
        .eq("user_id", userId).in("name_norm", batch);
      if (error) throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
      return (data ?? []) as { name_norm: string; status: string | null; rev: unknown }[];
    });
    const out = new Map<string, MembershipMark>();
    for (const row of rows) {
      const rev = Number(row.rev);
      if (!Number.isSafeInteger(rev) || rev < 0) throw new Error("malformed food membership revision");
      const status = row.status === "eats" || row.status === "avoid" ? row.status : null;
      out.set(row.name_norm, { name_norm: row.name_norm, status, rev });
    }
    return out;
  };
}

export const readMembershipRevisions: MembershipReader = membershipReader(adminClient);

/** At most this many families per `favor_family_sets` call (the function's own bound). */
export const FAMILY_BATCH = 20;

/** Each family's exact write set (what `set_food_membership` would write), keyed by the name asked. */
export type FamilySets = (userId: string, families: string[]) => Promise<Map<string, string[]>>;

const fail = (error: unknown) => {
  throw error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));
};

/** `favor_family_sets` (migration 20261215090000), service role, always for the session user. */
export function familySetsReader(client: () => SupabaseClient): FamilySets {
  return async (userId, families) => {
    const out = new Map<string, string[]>();
    const names = [...new Set(families)].sort();
    for (let i = 0; i < names.length; i += FAMILY_BATCH) {
      const { data, error } = await client().rpc("favor_family_sets",
        { p_user: userId, p_families: names.slice(i, i + FAMILY_BATCH) });
      if (error) fail(error);
      for (const row of (Array.isArray(data) ? data : []) as { name?: unknown; ref_ids?: unknown }[]) {
        if (typeof row.name !== "string" || !Array.isArray(row.ref_ids)
          || !row.ref_ids.every((id) => typeof id === "string")) throw new Error("malformed family set");
        out.set(row.name, [...(row.ref_ids as string[])].sort());
      }
    }
    return out;
  };
}

export const readFamilySets: FamilySets = familySetsReader(adminClient);

export type FavorWrite = {
  keyFamily: string | null;
  families: { name_norm: string; ref_ids: string[] }[];
  allowed: string[];
  rulesVersion: number;
  evidenceVersion: number;
};

export type FavorOutcome =
  | { status: "ok"; favored: string[]; written: string[] }
  | { status: "rules_changed"; rulesVersion: number }
  | { status: "set_changed" | "avoid" | "not_allowed"; family: string };

export type FavorWriter = (userId: string, write: FavorWrite) => Promise<FavorOutcome>;

/** `favor_food_families` (migration 20261215090000): one transaction, all or nothing. */
export function favorWriter(client: () => SupabaseClient): FavorWriter {
  return async (userId, write) => {
    const { data, error } = await client().rpc("favor_food_families", {
      p_user: userId, p_key_family: write.keyFamily, p_families: write.families, p_allowed: write.allowed,
      p_rules_rev: write.rulesVersion, p_evidence_rev: write.evidenceVersion,
    });
    if (error) fail(error);
    const row = (data ?? {}) as Record<string, unknown>;
    const names = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string")
      ? value as string[] : null;
    if (row.status === "ok" && names(row.favored) && names(row.written)) {
      return { status: "ok", favored: names(row.favored)!, written: names(row.written)! };
    }
    if (row.status === "rules_changed") return { status: "rules_changed", rulesVersion: Number(row.rules_rev) };
    if ((row.status === "set_changed" || row.status === "avoid" || row.status === "not_allowed")
      && typeof row.family === "string") return { status: row.status, family: row.family };
    throw new Error("malformed favor result");
  };
}

export const writeFavorFamilies: FavorWriter = favorWriter(adminClient);
