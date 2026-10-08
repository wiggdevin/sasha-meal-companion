import { rolePayload, type JevPayload } from "@/lib/ai/payloads";
import { accountHandle } from "@/lib/device/account";

export const MEAL_COMPONENT_ROLES = {
  protein_anchor: "The food is chiefly the meal's protein anchor.",
  carb_source: "The food is chiefly the meal's carbohydrate source.",
  fat_source: "The food is chiefly the meal's fat source.",
  produce_or_free: "The food is produce or a low-macro supporting component.",
  mixed_dish: "The food is a mixed dish without one clear component role.",
  none: "None of the listed roles is a sound match.",
} as const;

export type MealComponentRole = keyof typeof MEAL_COMPONENT_ROLES;
export type NutrientBucket = "low" | "source" | "dense";
export type RoleAdviceFood = {
  foodRefId: string;
  name: string;
  description: string | null;
  prepState: string | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  storedRole: "protein" | "carb" | "fat" | null;
};
export type MealComponentRoleAdvice = {
  foodRefId: string;
  suggestedRole: Exclude<MealComponentRole, "none">;
  proposedRole: StoredMealRole | null;
  currentRole: StoredMealRole | null;
  reason: string;
  confidence: number;
  requiresConfirmation: boolean;
};
export type StoredMealRole = "protein" | "carb" | "fat";
export type RoleConfirmationResult =
  | { status: "awaiting_confirmation" }
  | { status: "not_storable" }
  | { status: "unchanged" | "persisted"; role: StoredMealRole };
export type RoleConfirmationOptions = {
  confirmed: boolean;
  currentRole?: (foodRefId: string) => Promise<StoredMealRole | null>;
  persistRole?: (foodRefId: string, role: StoredMealRole) => Promise<void>;
};
type RoleChoice = keyof typeof MEAL_COMPONENT_ROLES;
type RoleAnswers = { meal_component_role: {
  type: "choice"; choice: RoleChoice; probabilities: Record<RoleChoice, number>; confidence: number;
} };
export type RoleQuestions = { meal_component_role: {
  type: "choice"; instructions: string; criteria: typeof MEAL_COMPONENT_ROLES;
} };
/** Phase 13 §9 R3: the port takes the builder's payload (lib/ai/payloads.ts), never raw state. */
export type RolePort = (
  payload: JevPayload<"meal-component-role", RoleQuestions>,
  options: { userId: string; deadlineMs: number; signal?: AbortSignal },
) => Promise<RoleAnswers | null>;

export const ROLE_QUESTION = {
  type: "choice" as const,
  instructions: "Choose the food's best meal-component role. Use none when no option is sound.",
  criteria: MEAL_COMPONENT_ROLES,
};

/** Advisory only: the caller must present this result for confirmation before any persistence. */
export async function adviseMealComponentRole(
  food: RoleAdviceFood,
  options: {
    userId: string;
    deadlineMs?: number;
    signal?: AbortSignal;
    systemOne: RolePort;
  },
): Promise<MealComponentRoleAdvice | null> {
  if (food.storedRole !== null) return null;
  const payload = rolePayload({
    food: { name: food.name, description: food.description, prepState: food.prepState },
    nutrientBuckets: nutrientBuckets(food),
  });
  const answer = (await options.systemOne(payload, {
    userId: options.userId,
    deadlineMs: options.deadlineMs ?? 3_000,
    ...(options.signal ? { signal: options.signal } : {}),
  }))?.meal_component_role;
  if (!answer || answer.choice === "none" || storedRoleForAdvice(answer.choice) === null) return null;
  return {
    foodRefId: food.foodRefId,
    suggestedRole: answer.choice,
    proposedRole: storedRoleForAdvice(answer.choice),
    currentRole: food.storedRole,
    reason: MEAL_COMPONENT_ROLES[answer.choice],
    confidence: answer.confidence,
    requiresConfirmation: true,
  };
}

/**
 * The local automatic-role hand-off for advice that does not require a separate confirmation.
 * Confirm-required advice uses POST /api/foods/role/confirm; a stored role always wins here.
 */
export async function confirmMealComponentRole(
  advice: Pick<MealComponentRoleAdvice, "foodRefId" | "suggestedRole" | "requiresConfirmation">,
  options: RoleConfirmationOptions,
): Promise<RoleConfirmationResult> {
  if (!options.confirmed || advice.requiresConfirmation) return { status: "awaiting_confirmation" };
  const role = storedRoleForAdvice(advice.suggestedRole);
  if (role === null) return { status: "not_storable" };
  const currentRole = options.currentRole ?? readStoredRole;
  const current = await currentRole(advice.foodRefId);
  if (current !== null) return { status: "unchanged", role: current };
  await (options.persistRole ?? persistStoredRole)(advice.foodRefId, role);
  return { status: "persisted", role };
}

function storedRoleForAdvice(role: MealComponentRoleAdvice["suggestedRole"]): StoredMealRole | null {
  if (role === "protein_anchor") return "protein";
  if (role === "carb_source") return "carb";
  if (role === "fat_source") return "fat";
  return null;
}

async function readStoredRole(foodRefId: string): Promise<StoredMealRole | null> {
  const h = accountHandle();
  const { getRow } = await import("@/lib/sync/idb");
  const row = await getRow(h, "user_food_prefs", foodRefId) as { role?: unknown } | undefined;
  return row?.role === "protein" || row?.role === "carb" || row?.role === "fat"
    ? row.role : null;
}

async function persistStoredRole(foodRefId: string, role: StoredMealRole): Promise<void> {
  const h = accountHandle();
  const [{ getRow }, { enqueueWithRow }] = await Promise.all([
    import("@/lib/sync/idb"), import("@/lib/sync/outbox"),
  ]);
  const row = await getRow(h, "user_food_prefs", foodRefId) as Record<string, unknown> | undefined;
  if (!row || row.deleted_at || (row.status !== "eats" && row.status !== "avoid")) {
    throw new Error("Confirm the food's Favorites or Avoid membership before saving its role.");
  }
  if (row.role === "protein" || row.role === "carb" || row.role === "fat") return;
  const rev = typeof row.rev === "number" && Number.isSafeInteger(row.rev) ? row.rev : 0;
  const payload = {
    food_ref_id: foodRefId, status: row.status, role,
    no_cook: row.no_cook === true,
    note: typeof row.note === "string" ? row.note : null,
  };
  await enqueueWithRow(h, { ...row, ...payload, rev: rev + 1 }, {
    op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: foodRefId,
    kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
  });
}

export function nutrientBuckets(
  food: Pick<RoleAdviceFood, "proteinPer100g" | "carbsPer100g" | "fatPer100g">,
): { protein: NutrientBucket; carb: NutrientBucket; fat: NutrientBucket } {
  return {
    protein: nutrientBucket(food.proteinPer100g, 10, 20),
    carb: nutrientBucket(food.carbsPer100g, 10, 25),
    fat: nutrientBucket(food.fatPer100g, 5, 15),
  };
}

function nutrientBucket(value: number | null, source: number, dense: number): NutrientBucket {
  const amount = value ?? 0;
  if (amount >= dense) return "dense";
  if (amount >= source) return "source";
  return "low";
}
