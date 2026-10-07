// Shared stand-ins for the server target recompute tests: a settings row, the stale production
// target and a small chainable client for the reads the service makes and its one conditional RPC.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TargetProfile } from "@/lib/api-types";

export const USER = "40707946-0000-4000-8000-000000000001";
export const TODAY = "2026-10-03";

export type Row = Record<string, unknown>;

export function settingsRow(over: Row = {}): Row {
  return {
    user_id: USER, rev: 7, time_zone: "America/Denver", height_cm: 170.2, height_unit: "ft_in",
    weight_unit: "lb", birth_year: 1968, sex: "female", body_fat_pct: "32", body_fat_source: null,
    body_fat_measured_on: null, weight_kg: "72.575", activity_level: "moderate", goal: "recomp",
    goal_rate_bp_week: null, training_weekdays: [1, 3, 4, 5], onboarded_at: "2026-09-22T11:12:00Z",
    meals_per_day: null, training_kcal: null, rest_kcal: null, protein_g: null, ...over,
  };
}

/** The stale production shape: an older formula run left 2104/1888 with a legacy floor. */
export function staleTarget(over: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: "t5", user_id: USER, effective_from: "2026-09-22", rev: 5, kcal_train: 2104, kcal_rest: 1888,
    authored_by: "user", mode: "grams", protein_g: 145, fat_g: 56, carb_g: 255,
    protein_pct: null, fat_pct: null, carb_pct: null, kcal_min: 1200, protein_g_min: 145,
    fat_g_min: 50, carb_g_min: 100, goal_rate_bp_week: 0, max_weekly_kcal_step: 150,
    kcal_min_source: "legacy_default", notes: null, target_source: "derived",
    training_macros: { kcal: 2104, protein: 145, carbs: 255, fat: 56 },
    rest_macros: { kcal: 1888, protein: 145, carbs: 201, fat: 56 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
    input_weight_kg: 72.575, input_weight_source: "onboarding", input_training_weekdays: [1, 3, 4, 5],
    input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
    ...over,
  };
}

export type Fake = {
  client: SupabaseClient;
  targets: TargetProfile[];
  writes: Row[];
  conflicts: number;
  settings: { row: Row | null };
  /** Runs inside the RPC before the active-revision check, to simulate a concurrent commit. */
  beforeWrite?: (attempt: number) => void;
  /** Runs after a successful write, to simulate a settings save racing the recompute. */
  afterWrite?: (count: number) => void;
};

export function activeOn(targets: TargetProfile[], date: string): TargetProfile | null {
  return [...targets].filter((t) => t.effective_from <= date)
    .sort((a, b) => a.effective_from === b.effective_from ? b.rev - a.rev
      : a.effective_from < b.effective_from ? 1 : -1)[0] ?? null;
}

/** A small chainable stand-in for the reads the service makes and its one conditional RPC. */
export function fakeClient(row: Row | null, targets: TargetProfile[], weighIns: Row[] = []): Fake {
  const fake: Fake = { client: null as unknown as SupabaseClient, targets, writes: [], conflicts: 0,
    settings: { row } };
  let attempts = 0;
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let limit = Infinity;
    const rows = (): Row[] => {
      const source: Row[] = table === "user_settings" ? (fake.settings.row ? [fake.settings.row] : [])
        : table === "target_profiles" ? fake.targets as unknown as Row[]
          : table === "weigh_ins" ? weighIns : [];
      const out = source.filter((r) => filters.every((f) => f(r)));
      out.sort((a, b) => {
        for (const [key, ascending] of orders) {
          if (a[key] === b[key]) continue;
          return (String(a[key]) < String(b[key]) ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return out.slice(0, limit);
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return builder; },
      lte: (key: string, value: unknown) => {
        filters.push((r) => String(r[key]) <= String(value)); return builder;
      },
      gt: (key: string, value: unknown) => {
        filters.push((r) => String(r[key]) > String(value)); return builder;
      },
      order: (key: string, opts: { ascending: boolean }) => {
        orders.push([key, opts.ascending]); return builder;
      },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return builder;
  };
  const rpc = async (name: string, args: { p_user_id: string; p_row: Row; p_expected_id: string | null;
    p_expected_settings_rev: number | null }) => {
    if (name !== "write_target_revision_if_active") throw new Error(`unexpected rpc ${name}`);
    attempts += 1;
    fake.beforeWrite?.(attempts);
    const p = args.p_row as Row & { training_macros: Row; rest_macros: Row };
    const active = activeOn(fake.targets, String(p.effective_from));
    const settingsRev = fake.settings.row ? Number(fake.settings.row.rev) : null;
    if ((active?.id ?? null) !== args.p_expected_id || (args.p_expected_settings_rev !== null
      && settingsRev !== args.p_expected_settings_rev)) {
      fake.conflicts += 1;
      return { data: { conflict: true, active_id: active?.id ?? null }, error: null };
    }
    fake.writes.push(p);
    const rev = Math.max(0, ...fake.targets.map((t) => t.rev)) + 1;
    // Built from the payload alone, with the database's own defaults (write_target_revision).
    const written = {
      ...p, id: `t${rev}`, user_id: USER, rev, authored_by: "user", mode: "grams",
      kcal_train: Number(p.training_macros.kcal), kcal_rest: Number(p.rest_macros.kcal),
      kcal_min: p.kcal_min ?? 1650, protein_g_min: p.protein_g_min ?? p.training_macros.protein,
      fat_g_min: p.fat_g_min ?? 50, carb_g_min: p.carb_g_min ?? 100,
      goal_rate_bp_week: p.goal_rate_bp_week ?? 0,
    } as unknown as TargetProfile;
    fake.targets.push(written);
    fake.afterWrite?.(fake.writes.length);
    return { data: written, error: null };
  };
  fake.client = { from: query, rpc } as unknown as SupabaseClient;
  return fake;
}
