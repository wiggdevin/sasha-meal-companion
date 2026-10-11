/**
 * A menu's dishes against the account's rules, for a menu photo (lib/server/plan-inspire.ts) and an
 * uploaded menu (lib/server/plan-document.ts). A dish is judged from its name and the model's
 * ingredient guess (not a label: it can only add a finding, never clear one). The Avoid list is a
 * per-food mark, not part of the constraint profile, so the dish name and each ingredient are looked
 * up the way the coach grounds a named food (lib/coach/actions/ground-kit.ts groundNamedFood: the
 * food search's top hit and its prefStatus). Blocked dishes go; a restaurant dish is never safe.
 *
 * W014 (audit 2026-10-10 A130): the account's diet flags (vegetarian, halal, no_pork …) are judged
 * too, read beside the profile (readMenuProfile). A dish a flag blocks goes; any other dish of a
 * flagged account, or of one whose flags could not be read, says "Check it against your food rules".
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodHit } from "@/lib/coach/executors";
import { evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { isActiveHardRule } from "@/lib/policy/profiles/types";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";
import {
  MAX_MENU_PICKS, pickFromMenu, type MenuCandidate, type MenuPick, type MenuVerdict,
} from "@/lib/plan/photo-result";
import { MAX_MENU_CHECK } from "@/lib/plan/document-types";
import { readPolicyProfile, type PolicyProfile } from "@/lib/server/policy-profile";

/**
 * The rules a menu is screened against. `preferenceFlags` is the account's diet flags; `null` means
 * they could not be read (every dish then says "check it"), absent means the caller has none.
 */
export type MenuProfile = (PolicyProfile | ConstraintProfile) & {
  preferenceFlags?: readonly PolicyPreferenceFlag[] | null;
};

export type MenuSearch = (userId: string, query: string, limit: number) => Promise<FoodHit[]>;

/**
 * The most food searches one menu screen makes. A dish whose names were not all looked up is
 * dropped, never shown unchecked.
 */
export const MAX_MENU_LOOKUPS = 48;

/** One menu dish against the account's rules, with its Avoid-list mark already resolved. */
export function menuVerdict(profile: MenuProfile, dish: MenuCandidate, onAvoidList = false): MenuVerdict {
  const flags = profile.preferenceFlags;
  const verdict = evaluatePolicy(profile, {
    foodRefId: null, allergenTags: null, category: null, onEatsList: false, onAvoidList,
    ingredientsText: [dish.name, ...dish.ingredients].join(", "), ingredientsTextIsLabel: false,
    foodName: dish.name, packaged: false,
    ...(flags && flags.length > 0 ? { preferenceFlags: flags } : {}),
    ...("profileRules" in profile && profile.profileRules ? { profileRules: profile.profileRules } : {}),
  });
  if (verdict.verdict === "blocked") return { blocked: true, check: null };
  const allergens = [...new Set(profile.avoid_allergens.map((a) => a.trim()).filter(Boolean))];
  if (allergens.length > 0) return { blocked: false, check: askAbout(allergens.slice(0, 3)) };
  const rules = (profile.custom_rules?.length ?? 0) > 0 || profile.banned_categories.length > 0
    || flags === null || (flags?.length ?? 0) > 0
    || activeProfileRules(profile);
  if (rules) return { blocked: false, check: "Check it against your food rules" };
  // Re-audit r1 #6: a search miss is not a clear, so an account with Avoid marks is told to look.
  return { blocked: false, check: profile.avoid_food_ref_ids.length > 0 ? "Check it against your Avoid list" : null };
}

function activeProfileRules(profile: MenuProfile): boolean {
  const rules = "profileRules" in profile ? profile.profileRules : undefined;
  return rules?.items.some((rule) => isActiveHardRule(rule, rules.asOf)) ?? false;
}

/**
 * "Ask about peanuts, sesame", within the phone's check cap (documentResultSchema): labels are
 * free text, so a long one is cut on a word and the list stops at the cap (re-audit r1 #5).
 *
 * A line that stops short must never look like the whole list: whenever a label does not fit —
 * even the first one — the line ends with an explicit "and others" marker, inside the cap, rather
 * than silently dropping the rest (2026-10-05 audit, MAJOR 5).
 */
const OMITTED_MARKER = ", and others";

export function askAbout(allergens: readonly string[]): string {
  const prefix = "Ask about";
  if (allergens.length === 0) return prefix;
  const full = allergens.reduce((out, label, i) => `${out}${i === 0 ? " " : ", "}${label}`, prefix);
  if (full.length <= MAX_MENU_CHECK) return full;

  // Keep whole labels only while one still leaves room for the marker that must follow.
  let out = prefix;
  let shown = 0;
  for (const label of allergens) {
    const next = `${out}${shown === 0 ? " " : ", "}${label}`;
    if (next.length + OMITTED_MARKER.length > MAX_MENU_CHECK) break;
    out = next;
    shown += 1;
  }
  if (shown === 0) {
    // Not even the first label fits whole: show as much of it as the cap allows, still marked.
    const room = MAX_MENU_CHECK - prefix.length - 1 - OMITTED_MARKER.length;
    const cut = allergens[0].slice(0, Math.max(room, 0)).replace(/\s+\S*$/, "");
    out = `${prefix} ${cut}`;
  }
  return `${out}${OMITTED_MARKER}`;
}

/** pickFromMenu's own order (nearest the slot's kcal, protein breaks a tie; else the menu's). */
function ranked(candidates: readonly MenuCandidate[], targetKcal: number | undefined): MenuCandidate[] {
  return targetKcal ? [...candidates].sort((a, b) =>
    Math.abs(a.kcal - targetKcal) - Math.abs(b.kcal - targetKcal) || b.protein - a.protein) : [...candidates];
}

/**
 * The best three dishes for the slot, each screened against the account's rules and Avoid list.
 * Dishes are screened in pick order and screening stops once three pass, so a long menu costs a
 * few searches, not one per ingredient of every dish. The picks equal a full screen's picks.
 */
export async function screenMenu(userId: string, candidates: readonly MenuCandidate[],
  targetKcal: number | undefined, profile: MenuProfile,
  searchFoods: MenuSearch): Promise<MenuPick[]> {
  const seen = new Map<string, Promise<boolean>>();
  const avoided = (term: string): Promise<boolean> | null => {
    const key = term.trim().toLowerCase();
    const known = seen.get(key);
    if (known) return known;
    if (seen.size >= MAX_MENU_LOOKUPS) return null;
    const look = searchFoods(userId, term, 1).then(([hit]) => Boolean(hit && hit.foodRefId !== null
      && (hit.prefStatus === "avoid" || profile.avoid_food_ref_ids.includes(hit.foodRefId))));
    seen.set(key, look);
    return look;
  };
  const verdicts = new Map<MenuCandidate, MenuVerdict>();
  const order = ranked(candidates, targetKcal);
  let passed = 0;
  let at = 0;
  while (passed < MAX_MENU_PICKS && at < order.length) {
    const batch = order.slice(at, at + MAX_MENU_PICKS - passed);
    at += batch.length;
    const judged = await Promise.all(batch.map(async (dish) => {
      const looks = [dish.name, ...dish.ingredients].map(avoided);
      // Not every name could be looked up: drop the dish rather than show it unchecked.
      if (looks.some((look) => look === null)) return { blocked: true, check: null };
      return menuVerdict(profile, dish, (await Promise.all(looks)).some(Boolean));
    }));
    batch.forEach((dish, i) => verdicts.set(dish, judged[i]));
    passed += judged.filter((verdict) => !verdict.blocked).length;
  }
  const screened = order.slice(0, at);
  return pickFromMenu(screened, targetKcal, (dish) => verdicts.get(dish) ?? { blocked: true, check: null });
}

/** The account's diet flags, or null when the row or its flags could not be read (fail to check). */
export async function readMenuFlags(admin: SupabaseClient, userId: string):
  Promise<PolicyPreferenceFlag[] | null> {
  try {
    const { data, error } = await admin.from("user_settings").select("diet_prefs")
      .eq("user_id", userId).maybeSingle();
    if (error) return null;
    const raw = (data as { diet_prefs?: { flags?: unknown } | null } | null)?.diet_prefs?.flags;
    if (raw !== undefined && raw !== null
      && (!Array.isArray(raw) || raw.some((flag) => typeof flag !== "string"))) return null;
    return normalizePreferenceFlags(Array.isArray(raw) ? raw : []) as PolicyPreferenceFlag[];
  } catch {
    return null;
  }
}

/** The constraint profile and the diet flags a menu is screened against, read together. */
export async function readMenuProfile(admin: SupabaseClient, userId: string): Promise<MenuProfile> {
  const [{ profile }, preferenceFlags] = await Promise.all([
    readPolicyProfile(admin, userId, new Date()), readMenuFlags(admin, userId),
  ]);
  return { ...profile, preferenceFlags };
}

/** The food search the coach grounds with, as the signed-in user (their Eats and Avoid marks). */
export async function defaultMenuSearch(admin: SupabaseClient, client: SupabaseClient,
  localDate: string): Promise<MenuSearch> {
  const { defaultPorts } = await import("@/lib/server/coach-ports");
  return defaultPorts(client, admin, randomUUID, { tz: "UTC", date: localDate }).searchFoods;
}
