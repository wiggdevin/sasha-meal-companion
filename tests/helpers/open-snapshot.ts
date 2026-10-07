/**
 * Phase 18 W8 test bodies: a v3 snapshot for an open account built the way the server builds it,
 * from the D4 admission (lib/foods/world/admission.ts) and the pure foods builder
 * (lib/foods/world/snapshot-foods.ts), with no database. Plus the phone's side: the same body
 * through JSON and the strict parse, into `openWorldInputs`.
 */
import type { Food } from "@/lib/foods";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE, UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import { admitUniverse, avoidFamilies, inAvoidFamily } from "@/lib/foods/world/admission";
import { snapshotFoodsV3, type OwnSnapshotFood } from "@/lib/foods/world/snapshot-foods";
import type { TasteContext } from "@/lib/foods/world/taste-inputs";
import { mealFamily, partsOf } from "@/lib/meals/parts";
import { PREFERENCE_VERSION } from "@/lib/meals/preference";
import { RANKING_VERSION, type LocalRefs } from "@/lib/meals/snapshot";
import { parseMealSnapshotV3, SNAPSHOT_V3, type MealSnapshotV3, type PlateRuleKey } from "@/lib/meals/snapshot-v3";
import { openWorldInputs, type OpenWorldInputs } from "@/lib/meals/open-world";
import { EMPTY_PROFILE, type ConstraintProfile } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import type { TasteResult } from "@/lib/meals/taste";
import type { Part } from "@/lib/meals/parts";

export const OPEN_ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const ITEMS: readonly UniverseItem[] = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
export const UNIVERSE_PARTS: Readonly<Record<string, readonly Part[]>> =
  Object.fromEntries(ITEMS.map((item) => [item.entry.id, item.parts]));

/** One of the account's own Favored foods, with the refs the phone's ref cache holds for it. */
export type OwnFood = { food: Food; userRefId: string };

export type OpenOptions = {
  accountId?: string;
  profile?: ConstraintProfile;
  flags?: PolicyPreferenceFlag[];
  avoidNames?: string[];
  favored?: OwnFood[];
  /** Universe ids to drop from the admitted set after admission (an unverified item, acceptance 11). */
  withhold?: string[];
  taste?: Pick<TasteResult, "m" | "identities">;
  cuisines?: TasteContext["cuisines"];
  dislikes?: TasteContext["dislikes"];
  rulesVersion?: number;
  evidenceVersion?: number;
  computedAt?: string;
};

export function ownFood(id: string, name: string, role: Food["role"], per100: [number, number, number]): OwnFood {
  return { food: { id, name, role, unit: "g", perUnit: { protein: per100[0] / 100, carbs: per100[1] / 100,
    fat: per100[2] / 100 }, status: "eats", updatedAt: "2026-10-01" }, userRefId: `ref-${id}` };
}

/** A v3 body the way the server would build it for these rules and this taste. */
export function openSnapshot(options: OpenOptions = {}): MealSnapshotV3 {
  const families = avoidFamilies(options.avoidNames ?? []);
  const flags = options.flags ?? [];
  const plateRules: PlateRuleKey[] = flags.includes("kosher") ? ["kosher_meat_dairy"] : [];
  const admitted = admitUniverse(ITEMS, { profile: options.profile ?? EMPTY_PROFILE, preferenceFlags: flags,
    avoidFamilies: families });
  const withheld = new Set(options.withhold ?? []);
  const admittedUniverseIds = admitted.admitted.filter((id) => !withheld.has(id));
  const favored = options.favored ?? [];
  const admittedRefIds = favored.filter((own) => !inAvoidFamily([own.food.name], families))
    .map((own) => own.userRefId).sort();
  const own: OwnSnapshotFood[] = favored.map((row) => ({ id: row.food.id, food: row.food, parts: partsOf(row.food),
    family: mealFamily(row.food.name)?.key ?? null, userRefId: row.userRefId, catalogRefId: null }));
  const foods = snapshotFoodsV3({ own, admittedRefIds, admittedUniverseIds, plateRules, context: {
    profile: options.taste ?? { m: 0, identities: [] }, identities: new Map(), dislikes: options.dislikes ?? [],
    cuisines: options.cuisines ?? [], prior: { prior: { status: "neutral", reason: "country_unset" }, cohort: "national" },
    universeParts: UNIVERSE_PARTS, graph: null } });
  return {
    schemaVersion: SNAPSHOT_V3, rankingVersion: RANKING_VERSION, universeVersion: UNIVERSE_VERSION, universeHash: UNIVERSE_HASH,
    prefVersion: PREFERENCE_VERSION, priorVersion: "neutral", graphVersion: "none",
    accountId: options.accountId ?? OPEN_ACCOUNT, rulesVersion: options.rulesVersion ?? 7,
    evidenceVersion: options.evidenceVersion ?? 3, computedAt: options.computedAt ?? new Date().toISOString(),
    inputsHash: "test", world: "open", focusUntil: null, plateRules, admittedUniverseIds, admittedRefIds, foods,
    excluded: admitted.excluded.map((row) => ({ id: row.id, verdict: row.verdict, reason: row.reason })),
    eligible: { eligibleRefIds: admittedRefIds, eligibleFoodIds: favored.map((row) => row.food.id),
      eligibleCatalogFoodIds: [], excluded: [], rulesRevision: 1, preferenceFlags: flags },
  };
}

/** The phone's side: the body through JSON and the strict parse. Throws if the body is malformed. */
export function overTheWire(snapshot: MealSnapshotV3): MealSnapshotV3 {
  const parsed = parseMealSnapshotV3(JSON.parse(JSON.stringify(snapshot)));
  if (!parsed) throw new Error("the v3 body did not parse");
  return parsed;
}

/** The local foods and ref cache a device holds for these Favored foods. */
export function device(favored: readonly OwnFood[] = [], extra: readonly Food[] = []):
  { foods: Record<string, Food>; refs: LocalRefs } {
  return { foods: Object.fromEntries([...favored.map((row) => row.food), ...extra].map((food) => [food.id, food])),
    refs: Object.fromEntries(favored.map((row) => [row.food.id, { userRefId: row.userRefId }])) };
}

export function inputsFor(snapshot: MealSnapshotV3, favored: readonly OwnFood[] = [], extra: readonly Food[] = []):
  OpenWorldInputs {
  const local = device(favored, extra);
  return openWorldInputs(snapshot, local.foods, local.refs);
}
