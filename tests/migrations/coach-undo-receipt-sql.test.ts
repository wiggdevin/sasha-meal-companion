/**
 * Coach Undo receipts, PR A (docs/specs/coach-undo-receipt.md §7 steps 1–4) on a real, throwaway
 * Postgres: the rollout stages before any writer exists (review R1-4), both legacy closing
 * endpoints refusing a receipt record (R2-1), the immutability of receipts and `record_mode` (P2),
 * one receipt per action (R1-3, R1-6), and the rollback order (§7 rollback 1–4).
 *
 * The prelude stands in for the Supabase pieces (tests/migrations/coach-undo-prelude.ts). The
 * receipt-path checks against the real schema run on the local stack
 * (tests/coach/undo-receipt-local.integration.test.ts). Needs the Postgres server binaries
 * (PG_BIN, default Homebrew postgresql@16); skipped without them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COACH_UNDO_MIGRATIONS, coachUndoPrelude } from "./coach-undo-prelude";

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const ITEM = "3f1b1a2c-0000-4000-8000-0000000000d1";
const RECIPE = "3f1b1a2c-0000-4000-8000-0000000000c1";
const EGG = "3f1b1a2c-0000-4000-8000-0000000000f1";
const DATE = "2026-10-05";
const MEAL_BIND = { date: DATE, slot: "snack", items: [[EGG, 100]] };
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);

type Result = { out: string; err: string; ok: boolean };

function psql(db: string, args: string[]): Result {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", db, "-X",
    "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8", env: PG_ENV });
  return { out: r.stdout.trim(), err: r.stderr.trim(), ok: r.status === 0 };
}

/** SQL as postgres, as `role` alone, or as `user` under the authenticated role. */
function sql(db: string, text: string, as?: { user?: string; role?: string }): Result {
  const role = as?.user ? "authenticated" : as?.role;
  const wrapped = role ? `begin; set local role ${role};${as?.user
    ? ` set local request.jwt.claim.sub = '${as.user}';` : ""}\n${text};\ncommit;` : text;
  return psql(db, ["-c", wrapped]);
}

function must(db: string, text: string, as?: { user?: string; role?: string }): string {
  const r = sql(db, text, as);
  if (!r.ok) throw new Error(r.err);
  return r.out.split("\n").pop() ?? "";
}

function applyFile(db: string, file: string): Result {
  return psql(db, ["-1", "-f", file]);
}

function migrate(db: string, name: string): void {
  const r = applyFile(db, path.join(MIGRATIONS, name));
  if (!r.ok) throw new Error(`${name}: ${r.err}`);
}

function down(db: string, name: string): Result {
  return applyFile(db, path.join(MIGRATIONS, "down", name.replace(/\.sql$/, ".down.sql")));
}

/** A fresh database with the prelude and `steps` of the migrations applied. */
function freshDb(name: string, steps: number): void {
  must("postgres", `drop database if exists ${name}`);
  must("postgres", `create database ${name}`);
  const prelude = path.join(dir, `${name}-prelude.sql`);
  writeFileSync(prelude, coachUndoPrelude(A, B));
  const r = applyFile(name, prelude);
  if (!r.ok) throw new Error(r.err);
  for (const file of COACH_UNDO_MIGRATIONS.slice(0, steps)) migrate(name, file);
}

/** Today's targets: a snack of 100 g eggs at revision 3, six cups of water, a recipe. */
function resetTargets(db: string): void {
  must(db, `truncate log_entries, log_items, recipes, water_log, seen_ops;
    insert into log_entries values ('${ENTRY}', '${A}', 3, null, '${DATE}', 'snack',
      '2026-10-05T08:00:00Z');
    insert into log_items (id, entry_id, food_ref_id, grams) values ('${ITEM}', '${ENTRY}', '${EGG}', 100);
    insert into recipes values ('${RECIPE}', '${A}', 1, null, 'Eggs');
    insert into water_log values ('${A}', '${DATE}', 6, 2)`);
}

function legacyRecord(db: string, kind: string, inverse: object, expectedRev: number | null,
  bind: object = MEAL_BIND): string {
  return must(db, `insert into coach_action_undos (user_id, action_id, kind, inverse, expected_rev, bind)
    values ('${A}', '${crypto.randomUUID()}', '${kind}', '${JSON.stringify(inverse)}'::jsonb,
    ${expectedRev ?? "null"}, '${JSON.stringify(bind)}'::jsonb) returning id`);
}

/** A receipt_v1 record (and, unless `receipt` is false, its receipt) for the eggs snack. */
function receiptRecord(db: string, opts: { receipt?: boolean; actionId?: string } = {}): string {
  const actionId = opts.actionId ?? crypto.randomUUID();
  if (opts.receipt !== false) {
    const applied = { entryId: ENTRY, date: DATE, slot: "snack", eatenAt: "2026-10-05T08:00:00Z",
      rev: 3, title: null, items: [{ itemId: ITEM, foodRefId: EGG, name: "Eggs", grams: 100 }] };
    must(db, `insert into coach_action_receipts (user_id, action_id, kind, op_id, entity, entity_id,
      source_check, applied) values ('${A}', '${actionId}', 'log_meal', gen_random_uuid(),
      'log_entries', '${ENTRY}', 'match', '${JSON.stringify(applied)}'::jsonb)`);
  }
  return must(db, `insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode,
    source_check) values ('${A}', '${actionId}', 'log_meal', '{}', 'receipt_v1', 'match') returning id`);
}

function perform(db: string, id: string, local = false, user = A): { status?: string; error?: string } {
  const r = sql(db, `select perform_coach_undo('${id}', ${local})->>'status'`, { user });
  return r.ok ? { status: r.out.split("\n").pop() } : { error: r.err };
}

function recordUndone(db: string, actionId: string, kind = "log_meal"): Result {
  return sql(db, `select record_coach_undo('${actionId}', '${kind}', '{"kind":"${kind}"}'::jsonb, null,
    null, true)->>'status'`, { user: A });
}

describe.skipIf(!HAS_PG)("coach Undo receipt steps 1–4 on Postgres", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "coach-receipt-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    freshDb("applied", COACH_UNDO_MIGRATIONS.length);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"], { env: PG_ENV });
    rmSync(dir, { recursive: true, force: true });
  });

  it("R1-4: after each step in order, today's records undo through the legacy path", () => {
    freshDb("staged", 1); // main: the table only
    resetTargets("staged");
    const before = legacyRecord("staged", "log_meal",
      { kind: "log_meal", date: DATE, entryId: ENTRY, baseRev: 3 }, 3);
    for (let step = 1; step <= COACH_UNDO_MIGRATIONS.length; step += 1) {
      if (step > 1) migrate("staged", COACH_UNDO_MIGRATIONS[step - 1]);
      const name = COACH_UNDO_MIGRATIONS[step - 1];
      if (step >= 3) {
        // A record made before step 2 reads legacy.
        expect(must("staged", `select record_mode from coach_action_undos where id = '${before}'`)).toBe("legacy");
      }
      resetTargets("staged");
      const meal = legacyRecord("staged", "log_meal", { kind: "log_meal", date: DATE, entryId: ENTRY, baseRev: 3 }, 3);
      expect(perform("staged", meal), name).toEqual({ status: "undone" });
      const water = legacyRecord("staged", "log_water",
        { kind: "log_water", date: DATE, cups: 2, after: 6, afterRev: 2 }, 2, {});
      expect(perform("staged", water), name).toEqual({ status: "undone" });
      expect(must("staged", "select cups from water_log"), name).toBe("4");
      const recipe = legacyRecord("staged", "save_recipe", { kind: "save_recipe", recipeId: RECIPE, rev: 1 },
        1, { name: "Eggs" });
      // Step 3 on (index 4): legacy save_recipe server Undo is phone-only (spec §5).
      if (step >= 5) {
        expect(perform("staged", recipe).error, name).toContain("undo_local_only");
        expect(must("staged", "select deleted_at is null from recipes"), name).toBe("t");
      } else {
        expect(perform("staged", recipe), name).toEqual({ status: "undone" });
      }
      // The phone's own close of a legacy record still works at every stage.
      const local = legacyRecord("staged", "skip_slot", { kind: "skip_slot" }, null, {});
      expect(perform("staged", local, true), name).toEqual({ status: "undone" });
    }
  }, 60_000);

  it("R2-1: both legacy closing endpoints refuse a receipt record; undone_at stays null", () => {
    resetTargets("applied");
    const actionId = crypto.randomUUID();
    const id = receiptRecord("applied", { actionId });
    expect(perform("applied", id, true).error).toContain("undo_receipt_record");
    expect(recordUndone("applied", actionId).err).toContain("undo_receipt_record");
    expect(must("applied", `select undone_at is null from coach_action_undos where id = '${id}'`)).toBe("t");
    // Control: against legacy records both still close.
    const legacy = legacyRecord("applied", "log_meal", { kind: "log_meal", date: DATE, entryId: ENTRY }, null);
    expect(perform("applied", legacy, true)).toEqual({ status: "undone" });
    const other = must("applied", `insert into coach_action_undos (user_id, action_id, kind, inverse)
      values ('${A}', 'legacy-close', 'log_meal', '{}') returning action_id`);
    expect(recordUndone("applied", other).out).toBe("ok");
    expect(must("applied", `select undone_at is not null from coach_action_undos where action_id = 'legacy-close'`))
      .toBe("t");
  });

  it("a receipt record undoes from its receipt only, never from inverse", () => {
    resetTargets("applied");
    const id = receiptRecord("applied");
    expect(perform("applied", id)).toEqual({ status: "undone" });
    expect(must("applied", "select rev, deleted_at is not null from log_entries")).toBe("4|t");
    expect(perform("applied", id)).toEqual({ status: "already_undone" });
    // A receipt record with no receipt: refused, nothing written.
    resetTargets("applied");
    const bare = receiptRecord("applied", { receipt: false });
    expect(perform("applied", bare).error).toContain("undo_receipt_inconsistent");
    expect(must("applied", "select deleted_at is null from log_entries")).toBe("t");
    expect(perform("applied", bare, false, B)).toEqual({ status: "not_found" });
  });

  it("r1 BLOCK 1: a pre-submitted predictable op id cannot close the record without the inverse", () => {
    resetTargets("applied");
    const id = receiptRecord("applied");
    // The id the first draft derived from the record: a client could have sent it first.
    must("applied", `insert into seen_ops values (md5('coach-undo:' || '${id}')::uuid)`);
    expect(perform("applied", id)).toEqual({ status: "undone" });
    expect(must("applied", "select rev, deleted_at is not null from log_entries")).toBe("4|t");
  });

  it("legacy path: a pre-submitted predictable op id cannot close a record without its inverse", () => {
    resetTargets("applied");
    const meal = legacyRecord("applied", "log_meal", { kind: "log_meal", date: DATE, entryId: ENTRY, baseRev: 3 }, 3);
    const water = legacyRecord("applied", "log_water",
      { kind: "log_water", date: DATE, cups: 2, after: 6, afterRev: 2 }, 2, {});
    for (const id of [meal, water]) {
      must("applied", `insert into seen_ops values (md5('coach-undo:' || '${id}')::uuid)`);
      expect(perform("applied", id)).toEqual({ status: "undone" });
    }
    expect(must("applied", "select rev, deleted_at is not null from log_entries")).toBe("4|t");
    expect(must("applied", "select cups, rev from water_log")).toBe("4|3");
  });

  it("r1 BLOCK 1: a duplicate, or an applied op that wrote nothing, leaves the record open", () => {
    freshDb("faked", COACH_UNDO_MIGRATIONS.length);
    for (const answer of ["duplicate", "applied"]) {
      // The sync RPC answers without writing the target.
      must("faked", `create or replace function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
        language sql as $$ select jsonb_build_object('status', '${answer}') $$`);
      resetTargets("faked");
      const id = receiptRecord("faked");
      expect(perform("faked", id).error, answer).toContain("undo_conflict");
      expect(must("faked", `select undone_at is null from coach_action_undos where id = '${id}'`), answer)
        .toBe("t");
      expect(must("faked", "select rev, deleted_at is null from log_entries"), answer).toBe("3|t");
      // The legacy path, the same rule: a meal and a water add stay open, nothing written.
      const meal = legacyRecord("faked", "log_meal", { kind: "log_meal", date: DATE, entryId: ENTRY, baseRev: 3 }, 3);
      const water = legacyRecord("faked", "log_water",
        { kind: "log_water", date: DATE, cups: 2, after: 6, afterRev: 2 }, 2, {});
      for (const legacy of [meal, water]) {
        expect(perform("faked", legacy).error, `legacy ${answer}`).toContain("undo_conflict");
        expect(must("faked", `select undone_at is null from coach_action_undos where id = '${legacy}'`))
          .toBe("t");
      }
      expect(must("faked", "select cups, rev from water_log"), answer).toBe("6|2");
    }
  }, 30_000);

  it("a receipt record carries no inverse, and its mode and source never change", () => {
    const bad = sql("applied", `insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode,
      source_check) values ('${A}', 'shape', 'log_meal', '{"entryId":"x"}', 'receipt_v1', 'match')`);
    expect(bad.err).toContain("coach_action_undos_mode_shape");
    const legacySource = sql("applied", `insert into coach_action_undos (user_id, action_id, kind, inverse,
      source_check) values ('${A}', 'shape2', 'log_meal', '{}', 'match')`);
    expect(legacySource.err).toContain("coach_action_undos_mode_shape");
    const id = receiptRecord("applied");
    for (const set of ["record_mode = 'legacy'", "source_check = 'none'", `source = '{"x":1}'`]) {
      expect(sql("applied", `update coach_action_undos set ${set} where id = '${id}'`).err, set)
        .toContain("record_mode_immutable");
    }
    const legacy = legacyRecord("applied", "log_water", { kind: "log_water" }, null, {});
    expect(sql("applied", `update coach_action_undos set record_mode = 'receipt_v1', inverse = '{}',
      bind = '{}', source_check = 'match' where id = '${legacy}'`).err).toContain("record_mode_immutable");
  });

  it("P2: a receipt is immutable for every role, and only the account cascade removes it", () => {
    must("applied", "delete from coach_action_receipts");
    const actionId = crypto.randomUUID();
    receiptRecord("applied", { actionId });
    const where = `where action_id = '${actionId}'`;
    expect(sql("applied", `update coach_action_receipts set source_check = 'none' ${where}`).err)
      .toContain("receipt_immutable");
    expect(sql("applied", `update coach_action_receipts set source_check = 'none' ${where}`,
      { role: "service_role" }).err).toMatch(/permission denied/);
    expect(sql("applied", `delete from coach_action_receipts ${where}`, { role: "service_role" }).err)
      .toMatch(/permission denied/);
    expect(sql("applied", `update coach_action_receipts set source_check = 'none' ${where}`, { user: A }).err)
      .toMatch(/permission denied/);
    expect(sql("applied", `delete from coach_action_receipts ${where}`, { user: A }).err)
      .toMatch(/permission denied/);
    expect(sql("applied", `insert into coach_action_receipts (user_id, action_id, kind, op_id, entity,
      entity_id, source_check, applied) values ('${A}', 'own', 'log_meal', gen_random_uuid(),
      'log_entries', '${ENTRY}', 'match', '{}')`, { user: A }).err).toMatch(/permission denied/);
    // Owner-only select.
    expect(must("applied", `select count(*) from coach_action_receipts ${where}`, { user: A })).toBe("1");
    expect(must("applied", `select count(*) from coach_action_receipts ${where}`, { user: B })).toBe("0");
    // One receipt per action: a forged second one (service_role holds insert) is refused.
    expect(sql("applied", `insert into coach_action_receipts (user_id, action_id, kind, op_id, entity,
      entity_id, source_check, applied) values ('${A}', '${actionId}', 'save_recipe', gen_random_uuid(),
      'recipes', '${RECIPE}', 'match', '{}')`, { role: "service_role" }).err)
      .toContain("coach_action_receipts_action");
    // A kind writes its own entity only.
    expect(sql("applied", `insert into coach_action_receipts (user_id, action_id, kind, op_id, entity,
      entity_id, source_check, applied) values ('${A}', 'wrong', 'log_meal', gen_random_uuid(),
      'recipes', '${RECIPE}', 'match', '{}')`).err).toContain("coach_action_receipts_entity");
    // The account cascade still works (no delete trigger).
    must("applied", `insert into auth.users values ('cccccccc-0000-4000-8000-00000000000c');
      insert into coach_action_receipts (user_id, action_id, kind, op_id, entity, entity_id,
        source_check, applied) values ('cccccccc-0000-4000-8000-00000000000c', 'gone', 'log_meal',
        gen_random_uuid(), 'log_entries', '${ENTRY}', 'none', '{}');
      delete from auth.users where id = 'cccccccc-0000-4000-8000-00000000000c'`);
    expect(must("applied", "select count(*) from coach_action_receipts where action_id = 'gone'")).toBe("0");
  });

  it("R1-6: a receipt of another kind than its record is inconsistent and writes nothing", () => {
    resetTargets("applied");
    const actionId = crypto.randomUUID();
    must("applied", `insert into coach_action_receipts (user_id, action_id, kind, op_id, entity, entity_id,
      source_check, applied) values ('${A}', '${actionId}', 'save_recipe', gen_random_uuid(), 'recipes',
      '${RECIPE}', 'match', '{"recipeId":"${RECIPE}","rev":1,"revisionId":"x","items":[]}')`);
    const id = must("applied", `insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode,
      source_check) values ('${A}', '${actionId}', 'log_meal', '{}', 'receipt_v1', 'match') returning id`);
    expect(perform("applied", id).error).toContain("undo_receipt_inconsistent");
    expect(must("applied", "select count(*) from log_entries where deleted_at is null")).toBe("1");
    expect(must("applied", "select count(*) from recipes where deleted_at is null")).toBe("1");
  });

  it("rollback: the receipt-aware function stays while a receipt record is open; never the unguarded body", () => {
    freshDb("rolledback", COACH_UNDO_MIGRATIONS.length);
    resetTargets("rolledback");
    const id = receiptRecord("rolledback");
    const [step3, step4] = [COACH_UNDO_MIGRATIONS[4], COACH_UNDO_MIGRATIONS[5]];
    expect(down("rolledback", step4).err).toContain("unexpired receipt_v1 records exist");
    expect(down("rolledback", step3).err).toContain("receipt_v1 records exist");
    // Rollback 1–3 left the receipt-aware function in place: the record is still undoable.
    expect(perform("rolledback", id)).toEqual({ status: "undone" });
    // Once no unexpired receipt record remains, step 4 may go; step 3's body still refuses every
    // receipt record on both legacy entry points.
    must("rolledback", `alter table coach_action_undos disable trigger coach_action_undos_stamp;
      alter table coach_action_undos disable trigger coach_action_undos_mode_fixed;
      update coach_action_undos set created_at = now() - interval '9 days',
        expires_at = now() - interval '2 days' where id = '${id}';
      alter table coach_action_undos enable trigger coach_action_undos_stamp;
      alter table coach_action_undos enable trigger coach_action_undos_mode_fixed`);
    const r = down("rolledback", step4);
    expect(r.ok, r.err).toBe(true);
    resetTargets("rolledback");
    const open = receiptRecord("rolledback");
    expect(perform("rolledback", open).error).toContain("undo_receipt_inconsistent");
    expect(perform("rolledback", open, true).error).toContain("undo_receipt_record");
    const actionId = must("rolledback", `select action_id from coach_action_undos where id = '${open}'`);
    expect(recordUndone("rolledback", actionId).err).toContain("undo_receipt_record");
    expect(must("rolledback", "select deleted_at is null from log_entries")).toBe("t");
    // The unguarded 20261210090300 body never returns over a receipt record.
    expect(down("rolledback", step3).err).toContain("receipt_v1 records exist");
    // r1 WARN 3: the receipts table never goes while a receipt record exists, receipt or not, and
    // there is no override.
    must("rolledback", "delete from coach_action_receipts");
    expect(psql("rolledback", ["-c", "set app.allow_down_data_loss = 'on'", "-f",
      path.join(MIGRATIONS, "down", COACH_UNDO_MIGRATIONS[1].replace(/\.sql$/, ".down.sql"))]).err)
      .toContain("receipt_v1 records exist");
    expect(must("rolledback", "select to_regclass('coach_action_receipts') is not null")).toBe("t");
    // Re-applying step 4 brings the receipt path back; the receipts were deleted above, so the
    // record is inconsistent now and stays open.
    migrate("rolledback", step4);
    expect(perform("rolledback", open).error).toContain("undo_receipt_inconsistent");
  }, 30_000);

  it("the down files run in reverse order on a database that never held a receipt", () => {
    freshDb("downed", COACH_UNDO_MIGRATIONS.length);
    for (const name of [...COACH_UNDO_MIGRATIONS.slice(1)].reverse()) {
      const r = down("downed", name);
      expect(r.ok, `${name}: ${r.err}`).toBe(true);
    }
    expect(must("downed", "select to_regclass('coach_action_receipts') is null")).toBe("t");
    // Today's body is back, including the legacy recipe Undo, and the steps apply again.
    resetTargets("downed");
    const recipe = legacyRecord("downed", "save_recipe", { kind: "save_recipe", recipeId: RECIPE, rev: 1 },
      1, { name: "Eggs" });
    expect(perform("downed", recipe)).toEqual({ status: "undone" });
    for (const name of COACH_UNDO_MIGRATIONS.slice(1)) migrate("downed", name);
  }, 30_000);
});
