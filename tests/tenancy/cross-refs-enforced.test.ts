/**
 * Phase 9 spec 3.2: a row one account owns must not reference a row another account owns.
 * PR #247 (tests/tenancy/cross-refs.json) found 21 open cases: an insert and an update through
 * each of ten references, plus a coach message filed under another account's user_id. Migration
 * 20261103090100 closes them at the database, so every writer is covered: the signed-in client
 * (PostgREST), the SECURITY DEFINER sync RPC and the service role. PR #250 review r1 added the four
 * server-written references (health ingest and target proposals), which the service role writes.
 *
 * For each reference this suite proves that A's cross-account write is refused and the row does
 * not change, and that A's same-owner write (and a shared catalog food, or null where the column
 * allows it) still lands. It also proves normal sync of the same entities still applies, and that
 * plan_days has no client DELETE (spec 3 declares select, insert and update only).
 */
// Refuses any non-local database before anything else runs (PR #247 review r9).
import "./local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, ensureUser, resetUser, userClient, type TestUser,
} from "../helpers/supabase";
import { seedCatalogFood } from "../log/fixtures";
import { admin, hex, must, nextDate, one, seedOwned, type Owned } from "./xref-fixtures";

type Row = Record<string, unknown>;

/** One reference: the table, the column, how to build a row owned by `o`, and its key. */
type Ref = {
  name: string; table: string; column: string;
  target: (o: Owned) => string;
  row: (u: TestUser, o: Owned, ref: string | null, n: number) => Row;
  key: (row: Row) => Row;
  /** Extra same-owner values that must stay accepted (a catalog food ref, or null). */
  shared?: (catalogRef: string) => (string | null)[];
  /** False for server-written tables (select-only for the client): the service role writes. */
  clientWrites?: false;
};

const REFS: Ref[] = [
  { name: "log_items.food_ref_id", table: "log_items", column: "food_ref_id",
    target: (o) => o.foodRef,
    row: (_u, o, ref, n) => ({ id: crypto.randomUUID(), entry_id: o.entry, seq: n, qty: 1,
      unit: "g", food_ref_id: ref, grams: 10, snapshot: {} }),
    key: (r) => ({ id: r.id }), shared: (c) => [c] },
  { name: "favorites_meal_items.food_ref_id", table: "favorites_meal_items", column: "food_ref_id",
    target: (o) => o.foodRef,
    row: (_u, o, ref, n) => ({ meal_id: o.meal, seq: n, food_ref_id: ref, grams: 10 }),
    key: (r) => ({ meal_id: r.meal_id, seq: r.seq }), shared: (c) => [c] },
  { name: "recipe_items.food_ref_id", table: "recipe_items", column: "food_ref_id",
    target: (o) => o.foodRef,
    row: (_u, o, ref, n) => ({ recipe_revision_id: o.revision, seq: n, qty: 1, unit: "g",
      food_ref_id: ref, grams: 10 }),
    key: (r) => ({ recipe_revision_id: r.recipe_revision_id, seq: r.seq }), shared: (c) => [c] },
  { name: "user_food_prefs.food_ref_id", table: "user_food_prefs", column: "food_ref_id",
    target: (o) => o.foodRef,
    row: (u, _o, ref) => ({ user_id: u.id, food_ref_id: ref, status: "eats" }),
    key: (r) => ({ user_id: r.user_id, food_ref_id: r.food_ref_id }), shared: (c) => [c] },
  { name: "favorites_foods.food_ref_id", table: "favorites_foods", column: "food_ref_id",
    target: (o) => o.foodRef,
    row: (u, _o, ref) => ({ user_id: u.id, food_ref_id: ref }),
    key: (r) => ({ user_id: r.user_id, food_ref_id: r.food_ref_id }), shared: (c) => [c] },
  { name: "favorites_recipes.recipe_id", table: "favorites_recipes", column: "recipe_id",
    target: (o) => o.recipe,
    row: (u, _o, ref) => ({ user_id: u.id, recipe_id: ref }),
    key: (r) => ({ user_id: r.user_id, recipe_id: r.recipe_id }) },
  { name: "duplicate_group_members.entry_id", table: "duplicate_group_members", column: "entry_id",
    target: (o) => o.entry,
    row: (_u, o, ref) => ({ group_id: o.group, entry_id: ref }),
    key: (r) => ({ group_id: r.group_id, entry_id: r.entry_id }) },
  { name: "duplicate_groups.merged_into_entry_id", table: "duplicate_groups",
    column: "merged_into_entry_id", target: (o) => o.entry,
    row: (u, _o, ref) => ({ id: crypto.randomUUID(), user_id: u.id, local_date: "2026-11-03",
      slot: "meal1", fingerprint: `\\x${Buffer.from(crypto.randomUUID()).toString("hex")}`,
      merged_into_entry_id: ref }),
    key: (r) => ({ id: r.id }), shared: () => [null] },
  { name: "media_objects.entry_id", table: "media_objects", column: "entry_id",
    target: (o) => o.entry,
    row: (u, _o, ref) => ({ path: `media/${u.id}/${crypto.randomUUID()}.jpg`, user_id: u.id,
      kind: "image", bytes: 1, entry_id: ref }),
    key: (r) => ({ path: r.path }), shared: () => [null] },
  // Server-written tables: the client may only select them, so the service role is the writer.
  // An assistant coach row (the only kind with an ai_call_id) is server-written since W018.
  { name: "coach_messages.ai_call_id", table: "coach_messages", column: "ai_call_id",
    target: (o) => o.aiCall, clientWrites: false,
    row: (u, o, ref, n) => ({ thread_id: o.thread, user_id: u.id, role: "assistant", seq: n,
      ai_call_id: ref }),
    key: (r) => ({ thread_id: r.thread_id, seq: r.seq }), shared: () => [null] },
  { name: "ingest_events.source_id", table: "ingest_events", column: "source_id",
    target: (o) => o.source, clientWrites: false,
    row: (u, _o, ref) => ({ id: crypto.randomUUID(), user_id: u.id, status: "applied",
      source_id: ref, payload_hash: hex() }),
    key: (r) => ({ id: r.id }) },
  { name: "health_samples.source_id", table: "health_samples", column: "source_id",
    target: (o) => o.source, clientWrites: false,
    row: (u, _o, ref, n) => sample(u, ref, null, n),
    key: (r) => ({ id: r.id }) },
  { name: "health_samples.ingest_event_id", table: "health_samples", column: "ingest_event_id",
    target: (o) => o.event, clientWrites: false,
    row: (u, o, ref, n) => sample(u, o.source, ref, n),
    key: (r) => ({ id: r.id }), shared: () => [null] },
  { name: "target_proposals.based_on_estimate_id", table: "target_proposals",
    column: "based_on_estimate_id", target: (o) => o.estimate, clientWrites: false,
    row: (u, _o, ref) => ({ id: crypto.randomUUID(), user_id: u.id, proposed: {},
      status: "rejected", week_start: nextDate(), based_on_estimate_id: ref }),
    key: (r) => ({ id: r.id }), shared: () => [null] },
];

function sample(u: TestUser, source: string | null, event: string | null, n: number): Row {
  const start = new Date(Date.UTC(2026, 10, 3, 0, n)).toISOString();
  return { id: crypto.randomUUID(), user_id: u.id, type: "step_count", value: n, unit: "count",
    source_id: source, ingest_event_id: event, start_time: start, end_time: start, tz: "UTC" };
}

describe.skipIf(!HAS_BRANCH)("the database refuses rows that reference another account's rows", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let ownA: Owned;
  let ownB: Owned;
  let catalogRef: string;
  let seq = 100;
  const next = () => (seq += 1);

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
    asA = await userClient(a);
    [ownA, ownB] = await Promise.all([seedOwned(a, "a"), seedOwned(b, "b")]);
    catalogRef = (await seedCatalogFood(admin(), a.id, { sourceId: "p9-xref-rice",
      description: "Rice, xref", per100g: { energy_kcal: 130 } })).foodRefId;
  });

  afterAll(async () => {
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
    await admin().from("media_objects").delete().in("user_id", [a.id, b.id]);
  });

  async function stored(r: Ref, row: Row): Promise<Row | null> {
    const found = await must(admin().from(r.table).select("*").match(r.key(row)).maybeSingle(),
      `read ${r.table}`);
    return found as Row | null;
  }

  /** Drop rows left by an earlier case, since several tables are keyed on the reference itself. */
  async function clear(r: Ref): Promise<void> {
    let query = admin().from(r.table).delete()
      .in(r.column, [r.target(ownA), r.target(ownB), catalogRef]);
    // The seeded events share the seeded sources; keep them, the sample cases reference them.
    if (r.table === "ingest_events") query = query.not("id", "in", `(${ownA.event},${ownB.event})`);
    await must(query, `clear ${r.table}`);
  }

  for (const r of REFS) {
    const writer = () => (r.clientWrites === false ? admin() : asA);

    it(`${r.name}: A's insert that references B's row is refused`, async () => {
      await clear(r);
      const row = r.row(a, ownA, r.target(ownB), next());
      const { error } = await writer().from(r.table).insert(row);
      expect(error).not.toBeNull();
      expect(await stored(r, row)).toBeNull();
    });

    it(`${r.name}: A cannot repoint her row at B's row`, async () => {
      await clear(r);
      const row = r.row(a, ownA, r.target(ownA), next());
      await must(writer().from(r.table).insert(row), `seed ${r.table}`);
      const { error } = await writer().from(r.table).update({ [r.column]: r.target(ownB) })
        .match(r.key(row));
      expect(error).not.toBeNull();
      expect((await stored(r, row))?.[r.column]).toBe(r.target(ownA));
    });

    it(`${r.name}: the service role cannot write the cross-account reference either`, async () => {
      await clear(r);
      const row = r.row(a, ownA, r.target(ownB), next());
      const { error } = await admin().from(r.table).insert(row);
      expect(error).not.toBeNull();
      expect(await stored(r, row)).toBeNull();
    });

    it(`${r.name}: A's same-owner and shared references still land`, async () => {
      await clear(r);
      for (const ref of [r.target(ownA), ...(r.shared?.(catalogRef) ?? [])]) {
        const row = r.row(a, ownA, ref, next());
        await must(writer().from(r.table).insert(row), `insert ${r.table} → ${String(ref)}`);
        expect((await stored(r, row))?.[r.column]).toBe(ref);
      }
    });
  }

  describe("coach_messages.user_id must be the thread owner", () => {
    it("A cannot file a message in her thread under B's user_id", async () => {
      const row = { thread_id: ownA.thread, user_id: b.id, role: "user", seq: next(), content: "x" };
      const { error } = await asA.from("coach_messages").insert(row);
      expect(error).not.toBeNull();
      expect(await must(admin().from("coach_messages").select("id")
        .match({ thread_id: ownA.thread, seq: row.seq }), "read")).toEqual([]);
    });

    it("A cannot move her message to B's user_id", async () => {
      const row = { thread_id: ownA.thread, user_id: a.id, role: "user", seq: next(), content: "x" };
      await must(asA.from("coach_messages").insert(row), "seed message");
      const { error } = await asA.from("coach_messages").update({ user_id: b.id })
        .match({ thread_id: ownA.thread, seq: row.seq });
      expect(error).not.toBeNull();
      const kept = await one(admin().from("coach_messages").select("user_id")
        .match({ thread_id: ownA.thread, seq: row.seq }).single(), "read");
      expect(kept.user_id).toBe(a.id);
    });

    it("the service role cannot file a message whose user_id is not the thread owner", async () => {
      const { error } = await admin().from("coach_messages").insert(
        { thread_id: ownA.thread, user_id: b.id, role: "assistant", seq: next(), content: "x" });
      expect(error).not.toBeNull();
    });
  });

  describe("sync of the same entities", () => {
    async function op(entity: string, entityId: string, payload: Row) {
      return asA.rpc("apply_sync_op", { p_user_id: a.id, p_op: { op_id: crypto.randomUUID(),
        entity, entity_id: entityId, kind: "create", base_rev: null, payload,
        client_ts: new Date().toISOString() } });
    }
    beforeAll(async () => {
      for (const r of REFS) await clear(r);
    });
    const item = (ref: string) => ({ seq: 1, qty: 1, unit: "g", food_ref_id: ref, grams: 50 });

    it("applies ops whose references are A's own rows or shared catalog foods", async () => {
      const ops: [string, string, Row][] = [
        ["user_food_prefs", ownA.foodRef, { status: "eats" }],
        ["favorites_foods", catalogRef, {}],
        ["favorites_recipes", ownA.recipe, {}],
        ["log_entries", crypto.randomUUID(), { eaten_at: "2026-11-03T12:00:00Z", tz: "UTC",
          local_date: "2026-11-03", slot: "meal2", method: "search",
          items: [item(ownA.foodRef), { ...item(catalogRef), seq: 2 }] }],
        ["recipes", crypto.randomUUID(), { name: "xref tray", servings: 2,
          items: [item(ownA.foodRef), { ...item(catalogRef), seq: 2 }] }],
        ["favorites_meals", crypto.randomUUID(), { name: "xref meal",
          items: [{ seq: 1, food_ref_id: ownA.foodRef, grams: 20 }] }],
        ["duplicate_groups", crypto.randomUUID(), { local_date: "2026-11-03", slot: "meal1",
          fingerprint: Buffer.from(crypto.randomUUID()).toString("hex"), state: "merged",
          merged_into_entry_id: ownA.entry }],
      ];
      for (const [entity, key, payload] of ops) {
        const { data, error } = await op(entity, key, payload);
        expect([entity, error]).toEqual([entity, null]);
        expect([entity, (data as { status: string }).status]).toEqual([entity, "applied"]);
      }
    });

    it("refuses ops that reference B's rows", async () => {
      const ops: [string, string, Row][] = [
        ["user_food_prefs", ownB.foodRef, { status: "eats" }],
        ["favorites_foods", ownB.foodRef, {}],
        ["favorites_recipes", ownB.recipe, {}],
        ["log_entries", crypto.randomUUID(), { eaten_at: "2026-11-03T12:00:00Z", tz: "UTC",
          local_date: "2026-11-03", slot: "meal3", method: "search", items: [item(ownB.foodRef)] }],
        ["recipes", crypto.randomUUID(), { name: "xref steal", servings: 1,
          items: [item(ownB.foodRef)] }],
        ["favorites_meals", crypto.randomUUID(), { name: "xref steal",
          items: [{ seq: 1, food_ref_id: ownB.foodRef, grams: 20 }] }],
        ["duplicate_groups", crypto.randomUUID(), { local_date: "2026-11-03", slot: "meal1",
          fingerprint: Buffer.from(crypto.randomUUID()).toString("hex"), state: "merged",
          merged_into_entry_id: ownB.entry }],
      ];
      for (const [entity, key, payload] of ops) {
        const { error } = await op(entity, key, payload);
        expect([entity, error?.code]).toEqual([entity, "42501"]);
      }
      const leaked = await must(admin().from("log_items").select("id")
        .eq("food_ref_id", ownB.foodRef), "read log_items");
      expect(leaked).toEqual([]);
    });
  });

  describe("plan_days has no client delete", () => {
    it("A cannot delete her own plan day through the table", async () => {
      await must(asA.from("plan_days").insert({ user_id: a.id, local_date: "2026-11-03" }),
        "seed plan day");
      await asA.from("plan_days").delete().match({ user_id: a.id, local_date: "2026-11-03" });
      const kept = await must(admin().from("plan_days").select("local_date")
        .match({ user_id: a.id, local_date: "2026-11-03" }), "read plan day");
      expect(kept).toHaveLength(1);
    });
  });
});
