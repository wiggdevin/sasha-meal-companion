/**
 * Phase 18 D6 Favor doubles over the taste fixture's tables (tests/helpers/taste-fixture.ts):
 * - a session client under RLS: `food_membership_revisions` reads no row (no client read policy);
 * - `favor_family_sets` and `favor_food_families` (migration 20261215090000) modelled in memory:
 *   the same family selection, version check, preflight and all-or-nothing write. The SQL itself is
 *   proved on a migrated database by tests/migrations/favor-families-db.test.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseFoodName } from "@/lib/foods/base-name";
import {
  membershipReader, type FavorOutcome, type FavorWrite,
} from "@/lib/server/membership-revisions";
import type { FavorPorts } from "@/lib/server/taste-favor";
import type { TastePorts } from "@/lib/server/taste-admission";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";

export type FavorCall = { userId: string; write: FavorWrite };

/** The family of a ref as the database names it, or null. */
function familyOfRef(tables: Record<string, Row[]>, userId: string, refId: unknown): string | null {
  const ref = tables.food_refs.find((row) => row.id === refId);
  if (!ref) return null;
  const name = ref.kind === "user"
    ? tables.user_foods.find((food) => food.id === ref.user_food_id && food.user_id === userId && !food.deleted_at)?.name
    : tables.catalog_food_revisions.find((rev) => rev.catalog_food_id === ref.catalog_food_id && rev.is_active)?.description;
  return typeof name === "string" ? baseFoodName(name) || null : null;
}

/** `_favor_family_refs`: own refs by owner, then catalog refs by last use, 50 in all; sorted. */
export function familyRefs(tables: Record<string, Row[]>, userId: string, family: string): string[] {
  const own = tables.food_refs.filter((ref) => ref.kind === "user" && tables.user_foods.some((food) =>
    food.id === ref.user_food_id && food.user_id === userId && !food.deleted_at
    && baseFoodName(String(food.name)) === family)).map((ref) => String(ref.id)).sort();
  const used = (id: unknown) => String(tables.user_food_prefs.find((pref) => pref.user_id === userId
    && pref.food_ref_id === id)?.updated_at ?? "");
  const catalog = tables.food_refs.filter((ref) => ref.kind === "catalog" && tables.catalog_food_revisions.some((rev) =>
    rev.catalog_food_id === ref.catalog_food_id && rev.is_active && baseFoodName(String(rev.description)) === family))
    .sort((a, b) => used(b.id).localeCompare(used(a.id)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(50 - own.length, 0)).map((ref) => String(ref.id));
  return [...own, ...catalog].sort();
}

export function clockOf(tables: Record<string, Row[]>, userId: string): number {
  return Number(tables.account_rules_clock.find((row) => row.user_id === userId)?.rules_rev ?? 0);
}

export function bumpClock(tables: Record<string, Row[]>, userId: string): void {
  const row = tables.account_rules_clock.find((r) => r.user_id === userId);
  if (row) row.rules_rev = Number(row.rules_rev) + 1;
  else tables.account_rules_clock.push({ user_id: userId, rules_rev: 1 });
}

function familyAvoided(tables: Record<string, Row[]>, userId: string, family: string): boolean {
  return tables.food_membership_revisions.some((m) => m.user_id === userId && m.name_norm === family && m.status === "avoid")
    || tables.user_food_prefs.some((pref) => pref.user_id === userId && pref.status === "avoid"
      && familyOfRef(tables, userId, pref.food_ref_id) === family);
}

/** `favor_food_families`: version check, preflight of every family, then the captured ids. */
export function favorFamilies(tables: Record<string, Row[]>, userId: string, write: FavorWrite): FavorOutcome {
  const rules = clockOf(tables, userId);
  if (rules !== write.rulesVersion || Number(tables.evidence_clock[0].evidence_rev) !== write.evidenceVersion) {
    return { status: "rules_changed", rulesVersion: rules };
  }
  if (write.keyFamily && familyAvoided(tables, userId, write.keyFamily)) return { status: "avoid", family: write.keyFamily };
  const toWrite: { family: string; refIds: string[] }[] = [];
  const favored: string[] = [];
  for (const { name_norm: family, ref_ids: refIds } of [...write.families].sort((a, b) => a.name_norm.localeCompare(b.name_norm))) {
    const current = familyRefs(tables, userId, family);
    if (!current.length || current.join() !== [...refIds].sort().join()) return { status: "set_changed", family };
    if (familyAvoided(tables, userId, family) || tables.user_food_prefs.some((pref) => pref.user_id === userId
      && pref.status === "avoid" && current.includes(String(pref.food_ref_id)))) return { status: "avoid", family };
    if (current.some((id) => !write.allowed.includes(id))) return { status: "not_allowed", family };
    const mark = tables.food_membership_revisions.find((m) => m.user_id === userId && m.name_norm === family);
    if (mark?.status === "eats") favored.push(family);
    else toWrite.push({ family, refIds: current });
  }
  for (const { family, refIds } of toWrite) {
    let mark = tables.food_membership_revisions.find((m) => m.user_id === userId && m.name_norm === family);
    if (!mark) tables.food_membership_revisions.push(mark = { user_id: userId, name_norm: family, rev: 0 });
    const rev = Number(mark.rev) + 1;
    Object.assign(mark, { status: "eats", rev, favor_rev: rev });
    for (const id of refIds) {
      const pref = tables.user_food_prefs.find((row) => row.user_id === userId && row.food_ref_id === id);
      if (pref) pref.status = "eats";
      else tables.user_food_prefs.push({ user_id: userId, food_ref_id: id, status: "eats" });
    }
    favored.push(family);
  }
  if (toWrite.length) bumpClock(tables, userId);
  return { status: "ok", favored, written: toWrite.map(({ family }) => family) };
}

/** The session client under RLS: `food_membership_revisions` reads no row. */
export function sessionClient(tables: Record<string, Row[]>): SupabaseClient {
  const fake = fakeDb(tables).client;
  const hidden = fakeDb({ food_membership_revisions: [] }).client;
  const from = fake.from.bind(fake);
  (fake as unknown as { from: unknown }).from = (table: string) =>
    table === "food_membership_revisions" ? hidden.from(table) : from(table);
  return fake;
}

/** Favor ports over the tables; `calls` records every write. */
export function favorPorts(tables: Record<string, Row[]>, taste: TastePorts): FavorPorts & { calls: FavorCall[] } {
  tables.food_membership_revisions ??= [];
  tables.account_rules_clock ??= [];
  tables.evidence_clock ??= [{ id: 1, evidence_rev: 500 }];
  const calls: FavorCall[] = [];
  return {
    calls,
    taste,
    // The declared owner-filtered service-role read, here over the unfiltered tables.
    memberships: membershipReader(() => fakeDb(tables).client),
    familySets: async (userId, families) => new Map(families.map((family) => [family, familyRefs(tables, userId, family)])),
    write: async (userId, write) => {
      calls.push({ userId, write });
      return favorFamilies(tables, userId, write);
    },
    clock: async (_client, userId) => ({ rulesVersion: clockOf(tables, userId),
      evidenceVersion: Number(tables.evidence_clock[0].evidence_rev) }),
  };
}
