/**
 * Spec 3.3 (Phase 9 slice 3): every public function `authenticated` may execute is declared in
 * tests/tenancy/rpc-ops.json with a class, and the class is checked by running something:
 *
 * - `account`: the function is security definer or reads account-owned tables. Its `case` names an
 *   entry of CASES below, which calls it as user A with user B's ids and compares B's rows before
 *   and after. The loop at the bottom runs every declared case, so a declared case cannot be
 *   skipped. `externalTest` is allowed only where an executed cross-user suite already exists.
 * - `catalog` / `pure`: security invoker and its body names no account-owned table (read from
 *   pg_proc here, not from test source), so RLS or the absence of account data covers it.
 *
 * `_sync_current`, `_sync_upsert` and `_sync_tombstone` were executable by `authenticated` and
 * trusted their `p_user_id` (PR #247 finding). Migration 20261103090000 (branch
 * fix/p9-sync-rpc-grants) revokes that; the three cases at the end prove A is now refused.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { existsSync, readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, userClient, type TestUser,
} from "../helpers/supabase";
import { authenticatedFunctions, userTables } from "./catalog";
import { purge, seed } from "./seed";
import rpcs from "./rpc-ops.json";
import internalRpcs from "./rpc-internal.json";

type Declared = { class: "account" | "catalog" | "pure"; case?: string; externalTest?: string;
  reason?: string };
const declared = rpcs as Record<string, Declared>;
const internal = internalRpcs as Record<string, { class: "private_trigger";
  table: string; trigger: string; definer?: boolean; reason?: string }>;
const byClass = (c: Declared["class"]) => Object.entries(declared).filter(([, v]) => v.class === c);

/** Every row B owns in `table`, as stored, so a changed value (not only a count) is caught. */
async function rowsOf(table: string, owner: string): Promise<unknown[]> {
  const { data, error } = await adminClient().from(table).select("*").eq("user_id", owner);
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return (data ?? []).map((r) => JSON.stringify(r)).sort();
}

async function row(table: string, match: Record<string, unknown>) {
  const { data, error } = await adminClient().from(table).select("*").match(match).maybeSingle();
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function syncCreate(owner: string, entity: string, key: string, payload: object) {
  const { error } = await adminClient().rpc("apply_sync_op", { p_user_id: owner, p_op: {
    op_id: crypto.randomUUID(), entity, entity_id: key, kind: "create", base_rev: null,
    payload, client_ts: new Date().toISOString() } });
  if (error) throw new Error(`seed ${entity}: ${error.message}`);
}

const day = (year = 2041) => `${year}-${String(1 + Math.floor(Math.random() * 12))
  .padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;

describe.skipIf(!HAS_DB)("RPC manifest (spec 3.3)", () => {
  it("every function authenticated may execute is declared", () => {
    const found = authenticatedFunctions().map((f) => f.signature).sort();
    expect(found).toEqual(Object.keys(declared).sort());
  });

  it("every security-definer function is declared account", () => {
    const wrong = authenticatedFunctions().filter((f) => f.securityDefiner)
      .filter((f) => declared[f.signature]?.class !== "account").map((f) => f.signature);
    expect(wrong).toEqual([]);
  });

  it("catalog and pure functions are invoker and name no account-owned table", () => {
    const owned = userTables();
    const wrong = [...byClass("catalog"), ...byClass("pure")].filter(([sig]) => {
      const src = runSql(`select prosecdef || '|' || prosrc from pg_proc
        where oid = '${sig}'::regprocedure`);
      const [definer, body] = [src.slice(0, src.indexOf("|")), src.slice(src.indexOf("|") + 1)];
      // A table the body reads or writes, not a table name inside a string literal.
      const touches = (t: string) =>
        new RegExp(`\\b(from|join|update|into)\\s+(public\\.)?${t}\\b`, "i").test(body);
      return definer === "true" || owned.some(touches);
    }).map(([sig]) => sig);
    expect(wrong).toEqual([]);
  });

  it("every account function names an executed case or an existing external test", () => {
    const bad = byClass("account").filter(([, v]) => {
      if (v.case) return !(v.case in CASE_NAMES);
      if (!v.externalTest) return true;
      const [file, name] = v.externalTest.split("::");
      return !existsSync(file) || !readFileSync(file, "utf8").includes(`it("${name}"`);
    }).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("catalog and pure entries state a reason", () => {
    const silent = [...byClass("catalog"), ...byClass("pure")]
      .filter(([, v]) => (v.reason ?? "").length < 20).map(([k]) => k);
    expect(silent).toEqual([]);
  });

  it("private guard is a revoked trigger on the declared table (definer unless declared invoker)", () => {
    for (const [signature, entry] of Object.entries(internal)) {
      expect(entry.class).toBe("private_trigger");
      expect(declared[signature]).toBeUndefined();
      const found = runSql(`select p.prosecdef || '|' ||
        has_function_privilege('authenticated', p.oid, 'execute') || '|' ||
        coalesce(t.tgenabled::text, '') from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace and n.nspname='public'
        left join pg_trigger t on t.tgfoid=p.oid and t.tgname='${entry.trigger}'
          and t.tgrelid='public.${entry.table}'::regclass
        where p.oid='public.${signature}'::regprocedure`);
      expect(found).toBe(`${entry.definer ?? true}|false|O`);
    }
  });
});

/** Case ids, so the manifest check above can run without a database. */
const CASE_NAMES = {
  assert_caller: 1, apply_sync_op: 1, approve_target_proposal: 1, contradictions: 1,
  food_ref: 1, weigh_in: 1, revoke_token: 1, food_membership: 1, food_note: 1, sync_changes: 1,
  target_revision: 1, compute_item_snapshot: 1,
  recipe_accept: 1, recipe_consumed: 1, recipe_undo: 1, shopping_window: 1,
  coach_undo_record: 1, coach_undo_perform: 1, food_signals: 1, taste_confirm: 1, taste_undo: 1,
  care_points_sync: 1, care_purchase: 1, care_equip: 1, care_accolades_sync: 1,
  care_accolades_seen: 1, care_message_mark: 1, care_log_grew: 1,
  onboarding_events: 1, taste_dislike_remove: 1, taste_dislike_undo: 1,
} as const;
type CaseName = keyof typeof CASE_NAMES;

describe.skipIf(!HAS_BRANCH)("account RPCs, called by A with B's ids (spec 3.3)", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
  });

  afterAll(async () => {
    await purge([a.id, b.id]);
  });

  const CASES: Record<CaseName, () => Promise<void>> = {
    assert_caller: async () => {
      expect((await asA.rpc("_sync_assert_caller", { p_user_id: b.id })).error?.message)
        .toContain("forbidden");
      expect((await asA.rpc("_sync_assert_caller", { p_user_id: a.id })).error).toBeNull();
    },
    apply_sync_op: async () => {
      const date = day();
      await syncCreate(b.id, "water_log", date, { cups: 3 });
      const before = await rowsOf("water_log", b.id);
      const { error } = await asA.rpc("apply_sync_op", { p_user_id: b.id, p_op: {
        op_id: crypto.randomUUID(), entity: "water_log", entity_id: date, kind: "update",
        base_rev: 1, payload: { cups: 99 }, client_ts: new Date().toISOString() } });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("water_log", b.id)).toEqual(before);
    },
    approve_target_proposal: async () => {
      const proposal = await seed("target_proposals", b.id);
      const before = await rowsOf("target_proposals", b.id);
      expect((await asA.rpc("approve_target_proposal",
        { p_user_id: b.id, p_proposal_id: proposal.match.id })).error?.message).toContain("forbidden");
      expect((await asA.rpc("approve_target_proposal",
        { p_user_id: a.id, p_proposal_id: proposal.match.id })).data)
        .toMatchObject({ status: "not_found" });
      expect(await rowsOf("target_proposals", b.id)).toEqual(before);
    },
    contradictions: async () => {
      const { data, error } = await asA.rpc("food_membership_contradictions", { p_user: b.id });
      expect(error?.message).toContain("forbidden");
      expect(data).toBeNull();
    },
    food_ref: async () => {
      const food = await seed("user_foods", b.id);
      for (const owner of [b.id, a.id]) {
        const r = await asA.rpc("get_or_create_food_ref", { p_user_id: owner, p_kind: "user",
          p_catalog_food_id: null, p_user_food_id: food.match.id });
        expect(r.error?.message).toContain("forbidden");
      }
      expect(await row("food_refs", { user_food_id: food.match.id })).toBeNull();
    },
    weigh_in: async () => {
      const before = await rowsOf("health_samples", b.id);
      // A past day: the function refuses future dates.
      const { data, error } = await asA.rpc("health_weigh_in",
        { p_local_date: day(2020), p_tz: "UTC", p_kg: 70 });
      expect(error?.message ?? null).toBeNull();
      const sampleId = (data as { sample_id: string }[])[0].sample_id;
      expect((await row("health_samples", { id: sampleId }))?.user_id).toBe(a.id);
      expect(await rowsOf("health_samples", b.id)).toEqual(before);
    },
    revoke_token: async () => {
      const token = await seed("api_tokens", b.id);
      const before = await rowsOf("api_tokens", b.id);
      expect((await asA.rpc("revoke_api_token", { p_user_id: b.id, p_token_id: token.match.id }))
        .error?.message).toContain("forbidden");
      expect((await asA.rpc("revoke_api_token", { p_user_id: a.id, p_token_id: token.match.id }))
        .data).toBe(false);
      expect(await rowsOf("api_tokens", b.id)).toEqual(before);
    },
    food_membership: async () => {
      const before = await rowsOf("food_membership_revisions", b.id);
      const { error } = await asA.rpc("set_food_membership", { p_user: b.id,
        p_name_norm: `tenancy ${crypto.randomUUID()}`, p_status: "eats", p_note: null, p_rev: 0 });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("food_membership_revisions", b.id)).toEqual(before);
    },
    food_note: async () => {
      const food = await seed("user_foods", b.id);
      const foodBefore = await rowsOf("user_foods", b.id);
      const authorityBefore = await rowsOf("food_note_authority", b.id);
      const { error } = await asA.rpc("save_food_note", { p_user: b.id,
        p_food_id: food.match.id, p_food_ref_id: null, p_base_rev: food.row.rev ?? 1,
        p_expected_note: null, p_note: "cross-account note" });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("user_foods", b.id)).toEqual(foodBefore);
      expect(await rowsOf("food_note_authority", b.id)).toEqual(authorityBefore);
    },
    sync_changes: async () => {
      await syncCreate(b.id, "water_log", day(), { cups: 1 });
      const { data, error } = await asA.rpc("sync_changes",
        { p_user_id: b.id, p_since: 0, p_limit: 10 });
      expect(error?.message).toContain("forbidden");
      expect(data).toBeNull();
    },
    target_revision: async () => {
      await seed("target_profiles", b.id);
      const before = await rowsOf("target_profiles", b.id);
      expect((await asA.rpc("write_target_revision", { p_user_id: b.id, p_row: {} }))
        .error?.message).toContain("forbidden");
      expect((await asA.rpc("write_target_revision_pair",
        { p_user_id: b.id, p_predecessor: {}, p_row: {} })).error?.message).toContain("forbidden");
      expect((await asA.rpc("write_target_revision_if_active",
        { p_user_id: b.id, p_row: {}, p_expected_id: null })).error?.message).toContain("forbidden");
      expect(await rowsOf("target_profiles", b.id)).toEqual(before);
    },
    compute_item_snapshot: async () => {
      // Security invoker: B's user food and its ref are hidden from A by RLS.
      const foodId = crypto.randomUUID();
      const refId = crypto.randomUUID();
      const admin = adminClient();
      expect((await admin.from("user_foods").insert({ id: foodId, user_id: b.id, kind: "custom",
        name: "canary food", per_100g: { protein: 42 } })).error).toBeNull();
      expect((await admin.from("food_refs").insert({ id: refId, kind: "user",
        user_food_id: foodId })).error).toBeNull();
      const forB = await asB.rpc("compute_item_snapshot", { p_food_ref_id: refId, p_grams: 100 });
      expect(forB.data).toMatchObject({ protein: { amount: 42 } });
      const forA = await asA.rpc("compute_item_snapshot", { p_food_ref_id: refId, p_grams: 100 });
      expect(forA.error).toBeNull();
      expect(forA.data).toEqual({});
    },
    recipe_accept: async () => {
      const preview = await seed("recipe_plan_previews", b.id);
      const before = await rowsOf("recipe_plan_previews", b.id);
      expect((await asB.from("recipe_plan_previews").select("id")
        .eq("id", preview.match.id).single()).data?.id).toBe(preview.match.id);
      const result = await asA.rpc("recipe_accept_preview", {
        p_preview_id: preview.match.id, p_request_id: crypto.randomUUID(),
        p_accept_approximate: false,
      });
      expect(result.error).not.toBeNull();
      expect(await rowsOf("recipe_plan_previews", b.id)).toEqual(before);
    },
    recipe_consumed: async () => {
      const selection = await seed("recipe_plan_selections", b.id);
      await seed("recipe_plan_state", a.id);
      const before = await rowsOf("recipe_plan_selections", b.id);
      expect((await asB.from("recipe_plan_selections").select("id")
        .eq("id", selection.match.id).single()).data?.id).toBe(selection.match.id);
      const result = await asA.rpc("recipe_log_consumed", {
        p_request_id: crypto.randomUUID(), p_local_date: selection.row.local_date,
        p_slot_id: "meal-1", p_selection_id: selection.match.id,
        p_plan_revision: 1, p_actual_servings: 1,
      });
      expect(result.error).not.toBeNull();
      expect(await rowsOf("recipe_plan_selections", b.id)).toEqual(before);
    },
    recipe_undo: async () => {
      const dayRow = await seed("plan_days", b.id);
      const date = String(dayRow.row.local_date);
      // A has a real day on the same date. Her call must still be unable to reach B's
      // private slot authority or undo B's mark.
      expect((await asA.from("plan_days").insert({ user_id: a.id,
        local_date: date })).error).toBeNull();
      const changedAt = "2041-01-01T12:00:00Z";
      const epoch = crypto.randomUUID();
      const mark = { eaten_at: changedAt, changed_at: changedAt, history_epoch: epoch,
        consumed: { baseMealId: `recipe:${crypto.randomUUID()}`, title: "B canary meal",
          components: [{ name: "B canary meal", qty: 1, unit: "whole", role: "free",
            macros: { kcal: 100, protein: 10, carbs: 10, fat: 2 } }] } };
      const admin = adminClient();
      expect((await admin.from("recipe_consumed_slot_state").insert({ user_id: b.id,
        local_date: date, slot_id: "meal-1", mark, history_epoch: epoch })).error).toBeNull();
      expect((await admin.from("plan_days").update({ eaten_slots: { "meal-1": mark } })
        .eq("user_id", b.id).eq("local_date", date)).error).toBeNull();
      const stale = await asB.from("plan_days").update({ eaten_slots: {} })
        .eq("user_id", b.id).eq("local_date", date);
      expect(stale.error).toBeNull();
      expect((await row("plan_days", { user_id: b.id, local_date: date }))?.eaten_slots)
        .toEqual({ "meal-1": mark });
      const before = await rowsOf("plan_days", b.id);
      const stateBefore = await rowsOf("recipe_consumed_slot_state", b.id);
      const args = { p_request_id: crypto.randomUUID(), p_local_date: date,
        p_slot_id: "meal-1", p_expected_changed_at: changedAt };
      expect((await asA.rpc("recipe_undo_consumed", args)).error?.message)
        .toContain("logged meal changed");
      expect(await rowsOf("plan_days", b.id)).toEqual(before);
      expect(await rowsOf("recipe_consumed_slot_state", b.id)).toEqual(stateBefore);
      const control = await asB.rpc("recipe_undo_consumed", {
        ...args, p_request_id: crypto.randomUUID(),
      });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ replayed: false });
      expect(await rowsOf("recipe_consumed_slot_state", b.id)).not.toEqual(stateBefore);
    },
    coach_undo_record: async () => {
      // B's assistant message carries an action and a composed card; A names both.
      const message = await seed("coach_messages", b.id);
      const actionId = crypto.randomUUID();
      expect((await adminClient().from("coach_messages").update({ role: "assistant",
        tool_calls: { actions: [{ actionId, kind: "save_recipe", name: "B canary" }],
          composed: [{ wish: "eggs", items: [{ foodRefId: crypto.randomUUID(), grams: 100 }] }] } })
        .eq("id", message.match.id)).error).toBeNull();
      const before = await rowsOf("coach_action_undos", b.id);
      const call = (as: SupabaseClient, id: string, source: boolean) => as.rpc("record_coach_undo", {
        p_action_id: id, p_kind: "save_recipe", p_inverse: { kind: "save_recipe" },
        p_expected_rev: 1, p_thread_id: null, p_undone: false,
        p_source_message: source ? message.match.id : null, p_source_card: source ? 0 : null });
      expect((await call(asA, actionId, false)).data).toMatchObject({ status: "unknown_action" });
      expect((await call(asA, crypto.randomUUID(), true)).data)
        .toMatchObject({ status: "unknown_action" });
      expect(await rowsOf("coach_action_undos", b.id)).toEqual(before);
      // Control: B records her own action.
      expect((await call(asB, actionId, false)).data).toMatchObject({ status: "ok" });
      expect(await rowsOf("coach_action_undos", b.id)).not.toEqual(before);
    },
    taste_confirm: async () => {
      await seed("user_settings", b.id);
      const before = [await rowsOf("user_settings", b.id), await rowsOf("taste_chip_receipts", b.id)];
      const { error } = await asA.rpc("taste_chips_confirm", { p_user_id: b.id,
        p_action_id: "00000000-0000-4000-8000-0000000000f1", p_source: "settings",
        p_dislikes: ["t:bitter"], p_cuisines: [], p_coach: null });
      expect(error?.message).toContain("forbidden");
      expect([await rowsOf("user_settings", b.id), await rowsOf("taste_chip_receipts", b.id)]).toEqual(before);
    },
    taste_undo: async () => {
      await seed("user_settings", b.id);
      const receipt = await seed("taste_chip_receipts", b.id);
      const before = [await rowsOf("user_settings", b.id), await rowsOf("taste_chip_receipts", b.id)];
      const actionId = String((receipt.row as { action_id: string }).action_id);
      expect((await asA.rpc("taste_chips_undo", { p_user_id: b.id, p_action_id: actionId })).error?.message)
        .toContain("forbidden");
      // A's own id never reaches B's receipt.
      expect((await asA.rpc("taste_chips_undo", { p_user_id: a.id, p_action_id: actionId })).data)
        .toMatchObject({ status: "not_found" });
      expect([await rowsOf("user_settings", b.id), await rowsOf("taste_chip_receipts", b.id)]).toEqual(before);
    },
    taste_dislike_remove: async () => {
      await seed("user_settings", b.id);
      const before = await rowsOf("taste_dislike_removals", b.id);
      const { error } = await asA.rpc("taste_dislike_remove", { p_user_id: b.id,
        p_action_id: "00000000-0000-4000-8000-0000000000f3", p_key: "t:bitter" });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("taste_dislike_removals", b.id)).toEqual(before);
    },
    taste_dislike_undo: async () => {
      const receipt = await seed("taste_dislike_removals", b.id);
      const before = await rowsOf("taste_dislike_removals", b.id);
      const actionId = String((receipt.row as { action_id: string }).action_id);
      expect((await asA.rpc("taste_dislike_remove_undo", { p_user_id: b.id, p_action_id: actionId })).error?.message)
        .toContain("forbidden");
      // A's own id never reaches B's receipt.
      expect((await asA.rpc("taste_dislike_remove_undo", { p_user_id: a.id, p_action_id: actionId })).data)
        .toMatchObject({ status: "not_found" });
      expect(await rowsOf("taste_dislike_removals", b.id)).toEqual(before);
    },
    onboarding_events: async () => {
      // Followups #18: the batch is stored under auth.uid() only. A sends B's own event, with
      // B's user id and B's client event id: it lands as A's row, B's rows stay as they were.
      const seeded = await seed("onboarding_events", b.id);
      const before = await rowsOf("onboarding_events", b.id);
      const { data, error } = await asA.rpc("record_onboarding_events", { p_events: [seeded.row] });
      expect(error).toBeNull();
      expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: 0 }]);
      expect(await rowsOf("onboarding_events", b.id)).toEqual(before);
    },
    coach_undo_perform: async () => {
      const record = await seed("coach_action_undos", b.id);
      const before = await rowsOf("coach_action_undos", b.id);
      for (const local of [false, true]) {
        const { data, error } = await asA.rpc("perform_coach_undo",
          { p_undo_id: record.match.id, p_local: local });
        expect(error).toBeNull();
        expect(data).toMatchObject({ status: "not_found" });
      }
      expect(await rowsOf("coach_action_undos", b.id)).toEqual(before);
      // Control: B closes her own record.
      expect((await asB.rpc("perform_coach_undo", { p_undo_id: record.match.id, p_local: true }))
        .data).toMatchObject({ status: "undone" });
      expect((await row("coach_action_undos", record.match))?.undone_at).not.toBeNull();
    },
    food_signals: async () => {
      // Phase 18 W6: the batch is stored under auth.uid() only. A sends B's own event, with B's
      // user id and B's client event id: it lands as A's row, and B's rows stay as they were.
      const seeded = await seed("food_signal_events", b.id);
      const before = await rowsOf("food_signal_events", b.id);
      const { data, error } = await asA.rpc("record_food_signals", { p_events: [seeded.row] });
      expect(error).toBeNull();
      expect(data).toEqual([{ inserted: 1, duplicates: 0, rejected: 0 }]);
      expect(await rowsOf("food_signal_events", b.id)).toEqual(before);
      const mine = await adminClient().from("food_signal_events").select("user_id")
        .eq("client_event_id", seeded.row.client_event_id as string);
      expect((mine.data ?? []).map((r) => r.user_id).sort()).toEqual([a.id, b.id].sort());
    },
    shopping_window: async () => {
      const window = await seed("shopping_purchase_windows", b.id);
      const before = await rowsOf("shopping_purchase_windows", b.id);
      expect((await asB.from("shopping_purchase_windows").select("id")
        .eq("id", window.match.id).single()).data?.id).toBe(window.match.id);
      const result = await asA.rpc("shopping_patch_purchase_window", {
        p_period_id: window.row.period_id, p_window_id: window.match.id,
        p_expected_revision: 1, p_request_id: crypto.randomUUID(),
        p_patch: { checked: true },
      });
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject({ status: "not_found" });
      expect(await rowsOf("shopping_purchase_windows", b.id)).toEqual(before);
    },
    care_points_sync: async () => {
      const before = await rowsOf("care_points_ledger", b.id);
      const { error } = await asA.rpc("care_points_sync",
        { p_user_id: b.id, p_local_date: day(2041), p_zone: "UTC" });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("care_points_ledger", b.id)).toEqual(before);
      // care_points_sync refuses a future local_date (real wall-clock, unlike the other cases'
      // synthetic 2041 dates), so the control call needs today's own real date.
      const today = new Date().toISOString().slice(0, 10);
      const control = await asB.rpc("care_points_sync",
        { p_user_id: b.id, p_local_date: today, p_zone: "UTC" });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ balance: expect.any(Number) });
    },
    care_purchase: async () => {
      const before = [await rowsOf("care_inventory", b.id), await rowsOf("care_purchase_receipts", b.id)];
      const { error } = await asA.rpc("care_purchase", { p_user_id: b.id, p_item_id: "leaf-pin",
        p_action_id: crypto.randomUUID(), p_local_date: day(2041), p_zone: "UTC" });
      expect(error?.message).toContain("forbidden");
      expect([await rowsOf("care_inventory", b.id), await rowsOf("care_purchase_receipts", b.id)]).toEqual(before);
      const control = await asB.rpc("care_purchase", { p_user_id: b.id, p_item_id: "leaf-pin",
        p_action_id: crypto.randomUUID(), p_local_date: day(2041), p_zone: "UTC" });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ status: expect.any(String) });
    },
    care_equip: async () => {
      const before = await rowsOf("care_equipped", b.id);
      const { error } = await asA.rpc("care_equip",
        { p_user_id: b.id, p_slot: "pin", p_item_id: null, p_rev: null });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("care_equipped", b.id)).toEqual(before);
      const control = await asB.rpc("care_equip",
        { p_user_id: b.id, p_slot: "pin", p_item_id: null, p_rev: null });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ status: "ok" });
    },
    care_accolades_sync: async () => {
      const before = await rowsOf("care_accolades", b.id);
      const { error } = await asA.rpc("care_accolades_sync",
        { p_user_id: b.id, p_local_date: day(2041), p_zone: "UTC" });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("care_accolades", b.id)).toEqual(before);
      const control = await asB.rpc("care_accolades_sync",
        { p_user_id: b.id, p_local_date: day(2041), p_zone: "UTC" });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ granted: expect.any(Array) });
    },
    care_accolades_seen: async () => {
      const grant = await seed("care_accolades", b.id);
      const before = await rowsOf("care_accolades", b.id);
      const { error } = await asA.rpc("care_accolades_seen", { p_user_id: b.id, p_keys: ["first-meal"] });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("care_accolades", b.id)).toEqual(before);
      const control = await asB.rpc("care_accolades_seen", { p_user_id: b.id, p_keys: ["first-meal"] });
      expect(control.error).toBeNull();
      expect(control.data).toBe(1);
      expect((await row("care_accolades", grant.match))?.seen_at).not.toBeNull();
    },
    care_message_mark: async () => {
      const message = await seed("care_messages", b.id);
      const before = await rowsOf("care_messages", b.id);
      const { error } = await asA.rpc("care_message_mark",
        { p_user_id: b.id, p_id: message.match.id, p_action: "read" });
      expect(error?.message).toContain("forbidden");
      expect(await rowsOf("care_messages", b.id)).toEqual(before);
      const control = await asB.rpc("care_message_mark",
        { p_user_id: b.id, p_id: message.match.id, p_action: "read" });
      expect(control.error).toBeNull();
      expect(control.data).toBe(true);
    },
    care_log_grew: async () => {
      const { error } = await asA.rpc("care_log_grew",
        { p_user_id: b.id, p_op_id: crypto.randomUUID(), p_zone: "UTC" });
      expect(error?.message).toContain("forbidden");
      const control = await asB.rpc("care_log_grew",
        { p_user_id: b.id, p_op_id: crypto.randomUUID(), p_zone: "UTC" });
      expect(control.error).toBeNull();
      expect(control.data).toMatchObject({ grew: false });
    },
  };

  for (const [sig, v] of byClass("account")) {
    if (!v.case) continue;
    it(`${sig}: ${v.case}`, async () => {
      await CASES[v.case as CaseName]();
    });
  }

  it("the private plan-day guard rejects a forged consumed marker", async () => {
    const date = day(2060);
    const changedAt = "2060-01-01T12:00:00Z";
    const marker = { eaten_at: changedAt, changed_at: changedAt,
      history_epoch: crypto.randomUUID(), consumed: {
        baseMealId: `recipe:${crypto.randomUUID()}`, title: "Forged recipe",
        components: [{ name: "Forged recipe", qty: 1, unit: "whole", role: "free",
          macros: { kcal: 100, protein: 10, carbs: 10, fat: 2 } }],
      } };
    const { error } = await asA.from("plan_days").insert({ user_id: a.id,
      local_date: date, eaten_slots: { "meal-1": marker } });
    expect(error?.message).toContain("recipe history marker requires online logging");
    expect(await row("plan_days", { user_id: a.id, local_date: date })).toBeNull();
  });

  it("_sync_current is refused to A and returns none of B's row", async () => {
    const date = day();
    await syncCreate(b.id, "water_log", date, { cups: 3 });
    const { data, error } = await asA.rpc("_sync_current",
      { p_user_id: b.id, p_entity: "water_log", p_key: date });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("_sync_upsert is refused to A and leaves B's row unchanged", async () => {
    const date = day();
    await syncCreate(b.id, "water_log", date, { cups: 3 });
    const before = await rowsOf("water_log", b.id);
    const { error } = await asA.rpc("_sync_upsert", { p_user_id: b.id, p_entity: "water_log",
      p_key: date, p_payload: { cups: 77 }, p_rev: 2 });
    expect(error).not.toBeNull();
    expect(await rowsOf("water_log", b.id)).toEqual(before);
  });

  it("_sync_tombstone is refused to A and leaves B's row alive", async () => {
    const food = await seed("user_foods", b.id);
    const { error } = await asA.rpc("_sync_tombstone", { p_user_id: b.id, p_entity: "user_foods",
      p_key: food.match.id, p_kind: "delete", p_rev: 2 });
    expect(error).not.toBeNull();
    expect((await row("user_foods", food.match))?.deleted_at).toBeNull();
  });
});
