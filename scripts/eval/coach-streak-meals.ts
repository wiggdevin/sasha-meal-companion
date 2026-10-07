import type { CoachAction } from "@/lib/coach/actions";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { calendarDateRange, shiftCalendarDate } from "@/lib/dates/range";
import { componentFromCatalog } from "@/lib/plan/catalog-component";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Assertion } from "./coach-streak-state";

type MealAction = Extract<CoachAction, { kind: "set_slot_meal" | "log_meal" }>;

const GENERIC_TITLE = /^(?:snack|breakfast|lunch|dinner|meal(?:\s*[·-]\s*|\s+)\d+)/i;

function assertion(name: string, passed: boolean, detail: unknown): Assertion {
  return { name, passed, detail: typeof detail === "string" ? detail : JSON.stringify(detail) };
}

function mealAction(response: CoachTurnResponse): MealAction | null {
  const actions = response.actions.filter((action): action is MealAction =>
    action.kind === "set_slot_meal" || action.kind === "log_meal");
  return actions.length === 1 ? actions[0] : null;
}

function kcalOf(action: MealAction | null): number | null {
  if (!action) return null;
  const values = action.items.map((item) => item.kcalPer100g === null
    ? null : item.kcalPer100g * item.grams / 100);
  return values.some((value) => value === null)
    ? null : Math.round(values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

function nextWeekday(today: string, weekday: number): string {
  const current = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  const distance = (weekday - current + 7) % 7 || 7;
  return shiftCalendarDate(today, distance);
}

function expectedDates(from: string, through: string, weekdays?: number[]): string[] {
  const range = calendarDateRange(from, through, weekdays);
  return range.ok ? range.dates : [];
}

function sameDates(actual: string[] | undefined, expected: string[]): boolean {
  return Array.isArray(actual) && actual.length <= 31 && actual.length === expected.length
    && actual.every((date, index) => date === expected[index]);
}

function actionAssertions(
  action: MealAction | null,
  expected: { kind: MealAction["kind"]; slot: string; title: string; dates?: string[];
    kcal: { min: number; max: number } },
): Assertion[] {
  const title = action?.title ?? "";
  const kcal = kcalOf(action);
  return [
    assertion("C9 meal action", action?.kind === expected.kind,
      { expected: expected.kind, actual: action?.kind ?? null }),
    assertion("C9 meal slot", action?.slot === expected.slot,
      { expected: expected.slot, actual: action?.slot ?? null }),
    assertion("C9 dish title", title === expected.title && !GENERIC_TITLE.test(title),
      { expected: expected.title, actual: title }),
    ...(expected.dates ? [assertion("C9 selected dates",
      action?.kind === "set_slot_meal" && sameDates(action.dates, expected.dates),
      { expected: expected.dates, actual: action?.kind === "set_slot_meal" ? action.dates : null })]
      : []),
    assertion("C9 calorie range", kcal !== null && kcal >= expected.kcal.min
      && kcal <= expected.kcal.max,
    { expected: expected.kcal, actual: kcal }),
  ];
}

export function mealCaseAssertions(
  caseId: string,
  response: CoachTurnResponse,
  today: string,
  materializedTitle: string | null = null,
): Assertion[] {
  if (caseId === "meals-p2-future-breakfast") {
    const expected = "Sourdough toast, bacon & eggs";
    const reply = response.messages.at(-1)?.content ?? "";
    return [
      assertion("C9 future plan materialized", materializedTitle === expected,
        { expected, actual: materializedTitle }),
      assertion("C9 future plan reported", reply.toLocaleLowerCase().includes(expected.toLocaleLowerCase()),
        { expected, actual: reply }),
    ];
  }
  const action = mealAction(response);
  if (caseId === "meals-p1-month-breakfast") {
    return actionAssertions(action, {
      kind: "set_slot_meal", slot: "meal-1", title: "Sourdough toast, bacon & eggs",
      dates: expectedDates(today, shiftCalendarDate(today, 30)), kcal: { min: 570, max: 700 },
    });
  }
  if (caseId === "meals-p3-next-tuesday-lunch") {
    const date = nextWeekday(today, 2);
    return actionAssertions(action, {
      kind: "set_slot_meal", slot: "meal-2", title: "Grilled chicken & rice",
      dates: [date], kcal: { min: 250, max: 450 },
    });
  }
  if (caseId === "meals-p4-spaghetti-snack") {
    return actionAssertions(action, {
      kind: "log_meal", slot: "snack", title: "Spaghetti bolognese",
      kcal: { min: 350, max: 600 },
    });
  }
  if (caseId === "meals-p6-weekday-oatmeal") {
    return actionAssertions(action, {
      kind: "set_slot_meal", slot: "meal-1", title: "Oatmeal with blueberries",
      dates: expectedDates(today, shiftCalendarDate(today, 13), [1, 2, 3, 4, 5]),
      kcal: { min: 150, max: 400 },
    });
  }
  return [];
}

type Harness = { db: SupabaseClient; client: SupabaseClient; userId: string };
type PlanRow = { local_date: string; day_type_override: string | null; floor_day: boolean;
  swaps: unknown; slot_notes: unknown; item_overrides: Record<string, unknown>; rev: number };

export type ProviderSpend = {
  totalUsd: number;
  providers: { provider: string; calls: number; costUsd: number; modelIds: string[] }[];
};

export async function userStateSnapshot(db: SupabaseClient, userId: string): Promise<string> {
  const [plans, logs] = await Promise.all([
    db.from("plan_days").select("local_date,item_overrides,rev").eq("user_id", userId)
      .order("local_date"),
    db.from("log_entries").select("id,local_date,slot,title,rev,deleted_at").eq("user_id", userId)
      .order("id"),
  ]);
  if (plans.error) throw plans.error;
  if (logs.error) throw logs.error;
  return JSON.stringify({ plans: plans.data ?? [], logs: logs.data ?? [] });
}

function components(action: Extract<MealAction, { kind: "set_slot_meal" }>) {
  return action.items.map((item) => componentFromCatalog(item.name, {
    energy_kcal: item.kcalPer100g,
    protein: item.proteinPer100g,
    carbohydrate: item.carbsPer100g,
    fat_total: item.fatPer100g,
  }, item.grams));
}

async function planRow(db: SupabaseClient, userId: string, date: string): Promise<PlanRow | null> {
  const row = await db.from("plan_days")
    .select("local_date,day_type_override,floor_day,swaps,slot_notes,item_overrides,rev")
    .eq("user_id", userId).eq("local_date", date).maybeSingle();
  if (row.error) throw row.error;
  return row.data as PlanRow | null;
}

/** Simulate the phone outbox after runTurn returns; the coach server itself remains read-only. */
export async function materializePhoneMeal(
  harness: Harness,
  action: Extract<MealAction, { kind: "set_slot_meal" }>,
): Promise<Assertion> {
  try {
    const dates = action.dates ?? [];
    const mealComponents = components(action);
    for (const date of dates) {
      const current = await planRow(harness.db, harness.userId, date);
      const itemOverrides = { ...(current?.item_overrides ?? {}), [action.slot]: {
        baseMealId: `coach-${action.slot}`,
        title: action.title,
        components: mealComponents,
      } };
      const op = {
        op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date,
        kind: current ? "update" : "create", base_rev: current?.rev ?? null,
        payload: {
          day_type_override: current?.day_type_override ?? null,
          floor_day: current?.floor_day ?? false,
          swaps: current?.swaps ?? {},
          slot_notes: current?.slot_notes ?? {},
          item_overrides: itemOverrides,
        },
        client_ts: new Date().toISOString(),
      };
      const result = await harness.client.rpc("apply_sync_op", {
        p_user_id: harness.userId, p_op: op,
      });
      if (result.error) throw result.error;
      if ((result.data as { status?: string } | null)?.status !== "applied") {
        throw new Error(`plan_days sync returned ${JSON.stringify(result.data)}`);
      }
    }
    const rows = await Promise.all(dates.map((date) => planRow(harness.db, harness.userId, date)));
    const saved = rows.every((row) => {
      const override = row?.item_overrides?.[action.slot] as { title?: unknown; components?: unknown };
      return override?.title === action.title && Array.isArray(override.components)
        && override.components.length === action.items.length;
    });
    return assertion("C9 phone-side materialization", saved,
      { dates: dates.length, title: action.title, slot: action.slot });
  } catch (error) {
    return assertion("C9 phone-side materialization", false,
      error instanceof Error ? error.message : String(error));
  }
}

export async function materializedMealTitle(
  db: SupabaseClient, userId: string, date: string, slot: string,
): Promise<string | null> {
  const row = await planRow(db, userId, date);
  const override = row?.item_overrides?.[slot] as { title?: unknown } | undefined;
  return typeof override?.title === "string" ? override.title : null;
}

export async function providerSpend(db: SupabaseClient, userId: string): Promise<ProviderSpend> {
  const rows = await db.from("ai_calls").select("provider,model_id,cost_estimate")
    .eq("user_id", userId);
  if (rows.error) throw rows.error;
  const grouped = new Map<string, { calls: number; costUsd: number; modelIds: Set<string> }>();
  for (const row of rows.data ?? []) {
    const provider = String(row.provider ?? "unknown");
    const value = grouped.get(provider) ?? { calls: 0, costUsd: 0, modelIds: new Set<string>() };
    value.calls += 1;
    value.costUsd += Number(row.cost_estimate ?? 0);
    if (row.model_id) value.modelIds.add(String(row.model_id));
    grouped.set(provider, value);
  }
  const providers = [...grouped].map(([provider, value]) => ({
    provider, calls: value.calls, costUsd: value.costUsd, modelIds: [...value.modelIds].sort(),
  })).sort((left, right) => left.provider.localeCompare(right.provider));
  return { totalUsd: providers.reduce((sum, value) => sum + value.costUsd, 0), providers };
}
