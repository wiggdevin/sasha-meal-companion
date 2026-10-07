/**
 * `perform_coach_undo` (migration 20261210090300, then the receipt steps 20261216090000..110400)
 * on a real, throwaway Postgres (review t4r2 #7):
 * initdb into a temp dir, a prelude that stands in for the Supabase pieces the function calls
 * (auth.uid() from the JWT claim, the owner tables, and `apply_sync_op` / `set_food_membership`
 * with their compare-and-swap contract), then the migration file itself. It proves the inverse is
 * built from the STORED record, the row locks serialize racing Undos, refusals roll back, RLS
 * hides other accounts, and clients cannot update or clear `undone_at`.
 *
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composedButtons } from "@/lib/coach/composed-buttons";
import { COACH_UNDO_MIGRATIONS, coachUndoPrelude } from "./coach-undo-prelude";

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const RECIPE = "3f1b1a2c-0000-4000-8000-0000000000c1";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const EGG = "3f1b1a2c-0000-4000-8000-0000000000f1";
const OTHER = "3f1b1a2c-0000-4000-8000-0000000000e2";
/** What record_coach_undo binds for the coach's "log 100 g of eggs as a snack today". */
const MEAL_BIND = { date: "2026-10-05", slot: "snack", items: [[EGG, 100]] };


let dir = "";
let port = 0;

function bin(name: string): string { return path.join(PG_BIN, name); }
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

/** Run SQL as postgres (no user) or as `user` under the authenticated role; returns rows as text. */
function sql(text: string, user?: string): { out: string; err: string; ok: boolean } {
  const wrapped = user
    ? `begin; set local role authenticated; set local request.jwt.claim.sub = '${user}';\n${text};\ncommit;`
    : text;
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
  return { out: r.stdout.trim(), err: r.stderr.trim(), ok: r.status === 0 };
}

function must(text: string, user?: string): string {
  const r = sql(text, user);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}

function undo(id: string, user = A, local = false): { status?: string; error?: string } {
  const r = sql(`select perform_coach_undo('${id}', ${local})->>'status';`, user);
  return r.ok ? { status: r.out.split("\n").pop() } : { error: r.err };
}

/** Insert a record directly (as the table owner); `record_coach_undo` has its own tests below. */
function recordAs(kind: string, inverse: object, expectedRev: number | null = null, user = A,
  bind: object = MEAL_BIND): string {
  return must(`insert into coach_action_undos (user_id, action_id, kind, inverse, expected_rev, bind)
    values ('${user}', '${crypto.randomUUID()}', '${kind}', '${JSON.stringify(inverse)}'::jsonb,
    ${expectedRev ?? "null"}, '${JSON.stringify(bind)}'::jsonb) returning id;`).split("\n").pop()!;
}

/** record_coach_undo as `user`; answers status and, when stored, whether it is undone. */
function recordVia(actionId: string, kind: string, user = A, undone = false,
  extra: { inverse?: object; source?: [string, number] } = {}): string {
  // A composed card's Log it names the tap: its local date and instant.
  const inverse = JSON.stringify(extra.inverse ?? (extra.source && kind === "log_meal"
    ? { kind, date: "2026-10-05", eatenAt: new Date().toISOString() } : { kind }));
  const source = extra.source ? `'${extra.source[0]}', ${extra.source[1]}` : "null, null";
  return must(`select r->>'status', coalesce((r->'row'->>'undone_at') is not null, false)
    from record_coach_undo('${actionId}', '${kind}', '${inverse}'::jsonb, null, null, ${undone},
      ${source}) r;`, user).split("\n").pop()!;
}

describe.skipIf(!HAS_PG)("perform_coach_undo on Postgres", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "coach-undo-pg-"));
    port = 54_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), coachUndoPrelude(A, B));
    // The table's migration, then every receipt step after it (docs/specs/coach-undo-receipt.md §7,
    // review R1-4): today's records keep undoing through the legacy path, the recipe case aside.
    for (const file of [path.join(dir, "prelude.sql"),
      ...COACH_UNDO_MIGRATIONS.map((name) => path.join(process.cwd(), "supabase/migrations", name))]) {
      const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
        "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
    }
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    must(`truncate coach_action_undos, log_entries, recipes, water_log, plan_days,
      food_membership_revisions, seen_ops, coach_messages, coach_threads, log_items;
      insert into log_entries values ('${ENTRY}', '${A}', 3, null, '2026-10-05', 'snack', now());
      insert into log_items (entry_id, food_ref_id, grams) values ('${ENTRY}', '${EGG}', 100.0);
      insert into recipes values ('${RECIPE}', '${A}', 1, null, 'Egg wrap');
      insert into coach_threads values ('${THREAD}', '${A}');
      insert into water_log values ('${A}', '2026-10-05', 6, 2);`);
  });

  it("deletes a meal at the stored commit revision and closes the record in one go", () => {
    const id = recordAs("log_meal", { kind: "log_meal", date: "2026-10-05", entryId: ENTRY, baseRev: 3 }, 3);
    expect(undo(id)).toEqual({ status: "undone" });
    expect(must(`select rev, deleted_at is not null from log_entries`)).toBe("4|t");
    expect(must(`select undone_at is not null from coach_action_undos where id = '${id}'`)).toBe("t");
    expect(undo(id)).toEqual({ status: "already_undone" });
  });

  it("refuses a meal edited since, writing nothing and leaving the record open", () => {
    const id = recordAs("log_meal", { kind: "log_meal", entryId: ENTRY, baseRev: 3 }, 3);
    must(`update log_entries set rev = 4`);
    expect(undo(id).error).toContain("undo_conflict");
    expect(must(`select deleted_at is null from log_entries`)).toBe("t");
    expect(must(`select undone_at is null from coach_action_undos where id = '${id}'`)).toBe("t");
  });

  it("uses only the stored inverse: a forged second argument cannot pick the write", () => {
    // The function takes the record id and a boolean; there is no op parameter to forge.
    const r = sql(`select perform_coach_undo('${crypto.randomUUID()}', '{"entity":"water_log"}'::jsonb);`, A);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/does not exist|cannot be cast|invalid input/);
  });

  it("water: subtracts once while the day holds exactly what the add left, never twice", () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    expect(undo(id)).toEqual({ status: "undone" });
    expect(must(`select cups from water_log`)).toBe("4");
    // The same add's record again: the row has moved past the revision it left (the first Undo).
    const again = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    expect(undo(again).error).toContain("undo_conflict");
    must(`update water_log set cups = 7`);
    expect(undo(again).error).toContain("undo_conflict");
    expect(must(`select cups from water_log`)).toBe("7");
  });

  it("water without the cups the add left is phone-only", () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2 });
    expect(undo(id).error).toContain("undo_local_only");
  });

  it("serializes racing Undos on the record lock: one writes, the other answers already undone", async () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    const slow = spawn(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-At", "-c", `begin; set local role authenticated;
        set local request.jwt.claim.sub = '${A}';
        select perform_coach_undo('${id}', false)->>'status'; select pg_sleep(1.5); commit;`]);
    let slowOut = "";
    slow.stdout.on("data", (chunk) => { slowOut += String(chunk); });
    const slowDone = new Promise((resolve) => slow.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = Date.now();
    const second = undo(id); // blocks on FOR UPDATE until the first commits
    await slowDone;
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(slowOut).toContain("undone");
    expect(second).toEqual({ status: "already_undone" });
    expect(must(`select cups from water_log`)).toBe("4");
  }, 20_000);

  it("skip: restores the previous override only while the slot holds what the skip wrote", () => {
    must(`insert into plan_days (user_id, local_date, slot_notes, item_overrides) values ('${A}',
      '2026-10-05', '{"meal-2":"keep"}', '{"meal-1":{"cleared":true,"components":[],"baseMealId":"m1",
      "mutationId":"3f1b1a2c-0000-4000-8000-0000000000aa"}}')`);
    const inverse = { kind: "skip_slot", date: "2026-10-05", slot: "meal-1",
      previous: { baseMealId: "m1", components: [], followPlan: true },
      applied: { baseMealId: "m1", components: [], cleared: true,
        mutationId: "3f1b1a2c-0000-4000-8000-0000000000aa" } };
    const id = recordAs("skip_slot", inverse);
    expect(undo(id)).toEqual({ status: "undone" });
    expect(must(`select item_overrides->'meal-1'->>'followPlan', slot_notes->>'meal-2' from plan_days`))
      .toBe("true|keep");
    const again = recordAs("skip_slot", inverse);
    expect(undo(again).error).toContain("undo_not_synced");
    must(`update plan_days set item_overrides = '{"meal-1":{"cleared":true,"components":[],
      "baseMealId":"m1","title":"Later"}}'`);
    expect(undo(again).error).toContain("undo_conflict");
  });

  it("list mark: returns the name to its previous status while the mark's revision is current", () => {
    const markRev = Date.now() + 3_600_000; // a phone clock ahead of the server's
    must(`insert into food_membership_revisions values ('${A}', 'watermelon', 'avoid', null, ${markRev})`);
    const id = recordAs("add_to_avoid", { kind: "add_to_avoid", name: "Watermelon, raw",
      nameNorm: "watermelon", previous: { status: "eats", note: "ok" } }, markRev);
    expect(undo(id)).toEqual({ status: "undone" });
    expect(must(`select status, note, rev = ${markRev + 1} from food_membership_revisions`)).toBe("eats|ok|t");
  });

  it("list mark: a later choice, even back to the same status, is never overwritten", () => {
    // Kale was in Eats; the coach put it in Avoid (rev 100); then Eats (rev 200), then Avoid (rev 300).
    must(`insert into food_membership_revisions values ('${A}', 'kale', 'avoid', null, 300)`);
    const id = recordAs("add_to_avoid", { kind: "add_to_avoid", nameNorm: "kale",
      previous: { status: "eats", note: null } }, 100);
    expect(undo(id).error).toContain("undo_conflict");
    expect(must(`select status, rev from food_membership_revisions`)).toBe("avoid|300");
    expect(must(`select undone_at is null from coach_action_undos where id = '${id}'`)).toBe("t");
  });

  it("list mark: a mark that has not arrived yet is not synced, and one with no revision is phone-only", () => {
    must(`insert into food_membership_revisions values ('${A}', 'kale', 'eats', null, 50)`);
    const id = recordAs("add_to_avoid", { kind: "add_to_avoid", nameNorm: "kale",
      previous: { status: "eats", note: null } }, 100);
    expect(undo(id).error).toContain("undo_not_synced");
    const noRev = recordAs("add_to_avoid", { kind: "add_to_avoid", nameNorm: "kale", previous: null });
    expect(undo(noRev).error).toContain("undo_local_only");
  });

  it("records only actions of the caller's own coach messages, closes on undone, and never inserts directly", () => {
    must(`insert into coach_messages values ('3f1b1a2c-0000-4000-8000-000000000011',
        '3f1b1a2c-0000-4000-8000-000000000001', '${A}',
        '{"actions":[{"actionId":"act-1","kind":"save_recipe"}]}') on conflict do nothing`);
    expect(recordVia("invented", "save_recipe")).toBe("unknown_action|f");
    expect(recordVia("act-1", "log_meal")).toBe("kind_mismatch|f");
    expect(recordVia("act-1", "save_recipe", B)).toBe("unknown_action|f");
    expect(recordVia("act-1", "save_recipe")).toBe("ok|f");
    expect(recordVia("act-1", "save_recipe", A, true)).toBe("ok|t");
    expect(sql(`insert into coach_action_undos (user_id, action_id, kind, inverse)
      values ('${A}', 'forged', 'log_water', '{"cups":2,"after":6}')`, A).err).toMatch(/permission denied/);
  });

  it("binds a record to the target its action names, and records a composed card's button by source", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000012";
    must(`insert into coach_messages values ('${MSG}', '3f1b1a2c-0000-4000-8000-000000000001', '${A}',
        '{"actions":[{"actionId":"act-w","kind":"log_water","date":"2026-10-05","ml":480}],
          "composed":[{"wish":"eggs","items":[{"foodRefId":"x","grams":1}]}]}')`);
    expect(recordVia("act-w", "log_water", A, false, { inverse: { kind: "log_water",
      date: "2026-10-01", cups: 2, after: 6 } })).toBe("target_mismatch|f");
    expect(recordVia("act-w", "log_water", A, false, { inverse: { kind: "log_water",
      date: "2026-10-05", cups: 2, after: 6 } })).toBe("ok|f");
    expect(recordVia("tap-1", "log_meal", A, false, { source: [MSG, 0] })).toBe("ok|f");
    expect(recordVia("tap-2", "log_meal", A, false, { source: [MSG, 1] })).toBe("unknown_action|f");
    expect(recordVia("tap-3", "log_water", A, false, { source: [MSG, 0] })).toBe("kind_mismatch|f");
    expect(recordVia("tap-4", "log_meal", B, false, { source: [MSG, 0] })).toBe("unknown_action|f");
  });

  it("requires each kind's identifying fields and binds what the token cannot carry", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000013";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}', '{"actions":[
      {"actionId":"skip","kind":"skip_slot","date":"2026-10-05","slot":"meal-1"},
      {"actionId":"avoid","kind":"add_to_avoid","name":"Kale"},
      {"actionId":"meal","kind":"log_meal","date":"2026-10-05","slot":"snack"},
      {"actionId":"recipe","kind":"save_recipe","name":"Egg wrap"}]}')`);
    expect(recordVia("skip", "skip_slot", A, false, { inverse: { kind: "skip_slot", slot: "meal-1" } }))
      .toBe("target_mismatch|f");
    expect(recordVia("avoid", "add_to_avoid", A, false, { inverse: { kind: "add_to_avoid" } }))
      .toBe("target_mismatch|f");
    expect(recordVia("meal", "log_meal", A, false, { inverse: { kind: "log_meal", entryId: ENTRY } }))
      .toBe("target_mismatch|f");
    expect(recordVia("recipe", "save_recipe", A, false, { inverse: { kind: "save_recipe",
      recipeId: RECIPE, rev: 1 } })).toBe("ok|f");
    expect(must(`select bind::text from coach_action_undos where action_id = 'recipe'`))
      .toBe('{"name": "Egg wrap"}');
  });

  it("deletes only the entry whose foods and grams are the ones the action logged", () => {
    // Another snack the same day, same revision: a forged token naming it is refused to the phone.
    must(`insert into log_entries values ('${OTHER}', '${A}', 3, null, '2026-10-05', 'snack', now());
      insert into log_items (entry_id, food_ref_id, grams) values ('${OTHER}', '${EGG}', 250)`);
    const forged = recordAs("log_meal", { kind: "log_meal", date: "2026-10-05", entryId: OTHER, baseRev: 3 }, 3);
    expect(undo(forged).error).toContain("undo_local_only");
    expect(must(`select count(*) from log_entries where deleted_at is null`)).toBe("2");
    const real = recordAs("log_meal", { kind: "log_meal", date: "2026-10-05", entryId: ENTRY, baseRev: 3 }, 3);
    expect(undo(real)).toEqual({ status: "undone" });
    expect(must(`select id from log_entries where deleted_at is not null`)).toBe(ENTRY);
  });

  it("binds a meal's foods and grams from the issued action at record time", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000016";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}', '{"actions":[{"actionId":"eggs",
      "kind":"log_meal","date":"2026-10-05","slot":"snack","items":[{"foodRefId":"${EGG}","grams":100}]}],
      "composed":[{"wish":"eggs","items":[{"foodRefId":"${EGG}","grams":100}]},{"wish":"none","items":[]}]}')`);
    expect(recordVia("eggs", "log_meal", A, false, { inverse: { kind: "log_meal", date: "2026-10-05",
      entryId: ENTRY } })).toBe("ok|f");
    expect(must(`select bind::text from coach_action_undos where action_id = 'eggs'`))
      .toBe(`{"date": "2026-10-05", "slot": "snack", "items": [["${EGG}", 100]]}`);
    expect(recordVia("tap", "log_meal", A, false, { source: [MSG, 0] })).toBe("ok|f");
    expect(must(`select bind->'items' = '[["${EGG}", 100]]' from coach_action_undos where action_id = 'tap'`))
      .toBe("t");
    // A card with no foods renders no buttons.
    expect(recordVia("tap-empty", "log_meal", A, false, { source: [MSG, 1] })).toBe("kind_mismatch|f");
  });

  it("water: the recorded amount must be the issued action's own", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000017";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}', '{"actions":[
      {"actionId":"w1","kind":"log_water","ml":240},{"actionId":"w2","kind":"log_water","ml":480},
      {"actionId":"w3","kind":"log_water"}]}')`);
    expect(recordVia("w1", "log_water", A, false, { inverse: { kind: "log_water", cups: 6, after: 6 } }))
      .toBe("target_mismatch|f");
    expect(recordVia("w2", "log_water", A, false, { inverse: { kind: "log_water", cups: 2, after: 6 } }))
      .toBe("ok|f");
    expect(recordVia("w3", "log_water", A, false, { inverse: { kind: "log_water", cups: 1, after: 6 } }))
      .toBe("target_mismatch|f");
  });

  it("a composed card's logged meal is bound to the tap's date and exact instant", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000018";
    const tap = new Date(Date.now() - 10 * 60_000).toISOString(); // today's 00:30, say
    const late = new Date(Date.now() - 90 * 60_000).toISOString(); // yesterday's 23:00 snack
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}', '{"composed":[
      {"wish":"eggs","items":[{"foodRefId":"${EGG}","grams":100}]}]}');
      update log_entries set eaten_at = '${tap}' where id = '${ENTRY}';
      insert into log_entries values ('${OTHER}', '${A}', 3, null, '2026-10-04', 'snack', '${late}');
      insert into log_items (entry_id, food_ref_id, grams) values ('${OTHER}', '${EGG}', 100)`);
    const rec = (actionId: string, entryId: string, date: string, eatenAt?: string) => {
      const inverse = JSON.stringify({ kind: "log_meal", date, entryId, baseRev: 3,
        ...(eatenAt ? { eatenAt } : {}) });
      return must(`select coalesce(r->'row'->>'id', r->>'status') from record_coach_undo('${actionId}',
        'log_meal', '${inverse}', 3, null, false, '${MSG}', 0) r;`, A).split("\n").pop()!;
    };
    // A token dated today naming yesterday's late snack, at either instant: not that entry.
    expect(undo(rec("a", OTHER, "2026-10-05", late)).error).toContain("undo_local_only");
    expect(undo(rec("b", OTHER, "2026-10-04", tap)).error).toContain("undo_local_only");
    // No instant, one in the future, or one older than the record's 7-day life: not recorded.
    expect(rec("c", ENTRY, "2026-10-05")).toBe("target_mismatch");
    expect(rec("d", ENTRY, "2026-10-05", new Date(Date.now() + 3_600_000).toISOString())).toBe("target_mismatch");
    expect(rec("e", ENTRY, "2026-10-05", new Date(Date.now() - 8 * 86_400_000).toISOString()))
      .toBe("target_mismatch");
    // The tap itself, flushed hours later from the queue, still binds: the instant is the phone's.
    expect(undo(rec("f", ENTRY, "2026-10-05", tap))).toEqual({ status: "undone" });
    expect(must(`select id from log_entries where deleted_at is not null`)).toBe(ENTRY);
  });

  it("skip → restore → skip: the first skip's Undo refuses the second skip's identical override", () => {
    const M1 = "3f1b1a2c-0000-4000-8000-0000000000a1";
    const M3 = "3f1b1a2c-0000-4000-8000-0000000000a3";
    const planned = { baseMealId: "m1", components: [], followPlan: true };
    must(`insert into plan_days (user_id, local_date, item_overrides) values ('${A}', '2026-10-05',
      '{"meal-1":{"cleared":true,"components":[],"baseMealId":"m1","mutationId":"${M3}"}}')`);
    const first = recordAs("skip_slot", { kind: "skip_slot", date: "2026-10-05", slot: "meal-1",
      previous: planned, applied: { baseMealId: "m1", components: [], cleared: true, mutationId: M1 } });
    expect(undo(first).error).toContain("undo_conflict");
    expect(must(`select item_overrides->'meal-1'->>'mutationId' from plan_days`)).toBe(M3);
  });

  it("skip → restore → skip → restore: the first restore's Undo leaves the later edits alone", () => {
    const R1 = "3f1b1a2c-0000-4000-8000-0000000000b1";
    const R2 = "3f1b1a2c-0000-4000-8000-0000000000b2";
    const shell = (id: string) => ({ baseMealId: "m1", components: [], followPlan: true, mutationId: id });
    // The second restore's marked shell is what the slot holds now.
    must(`insert into plan_days (user_id, local_date, item_overrides) values ('${A}', '2026-10-05',
      '${JSON.stringify({ "meal-1": shell(R2) })}')`);
    const firstRestore = recordAs("restore_slot", { kind: "restore_slot", date: "2026-10-05", slot: "meal-1",
      previous: { baseMealId: "m1", components: [], cleared: true, mutationId: "3f1b1a2c-0000-4000-8000-0000000000a1" },
      applied: shell(R1) });
    expect(undo(firstRestore).error).toContain("undo_conflict");
    expect(must(`select item_overrides->'meal-1'->>'mutationId' from plan_days`)).toBe(R2);
  });

  it("a meal queued offline (commit revision 1) is server-undoable from another device once synced", () => {
    must(`update log_entries set rev = 1`);
    const id = recordAs("log_meal", { kind: "log_meal", date: "2026-10-05", entryId: ENTRY, baseRev: null }, 1);
    expect(undo(id)).toEqual({ status: "undone" });
    expect(must(`select deleted_at is not null from log_entries`)).toBe("t");
  });

  it("water without the revision the add left is the phone's only", () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6 });
    expect(undo(id).error).toContain("undo_local_only");
    expect(must(`select cups from water_log`)).toBe("6");
  });

  it("a composed tap queued offline for six days is still recordable", () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000019";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}', '{"composed":[
      {"wish":"eggs","items":[{"foodRefId":"${EGG}","grams":100}]}]}')`);
    const sixDays = new Date(Date.now() - 6 * 86_400_000).toISOString();
    expect(recordVia("six", "log_meal", A, false, { source: [MSG, 0],
      inverse: { kind: "log_meal", date: "2026-09-29", entryId: ENTRY, baseRev: 3, eatenAt: sixDays } }))
      .toBe("ok|f");
  });

  it("water: the row revision the add left is checked as well as the count", () => {
    must(`update water_log set rev = 5`);
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 3 }, 3);
    expect(undo(id).error).toContain("undo_conflict"); // 6 → 5 → 6 since: same count, newer row
    expect(must(`select cups from water_log`)).toBe("6");
    const early = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 9 }, 9);
    expect(undo(early).error).toContain("undo_not_synced");
    const exact = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 5 }, 5);
    expect(undo(exact)).toEqual({ status: "undone" });
    expect(must(`select cups from water_log`)).toBe("4");
  });

  it("perform refuses to the phone a meal or recipe that is not the one the action named", () => {
    const otherSlot = recordAs("log_meal", { kind: "log_meal", entryId: ENTRY, baseRev: 3 }, 3, A,
      { date: "2026-10-05", slot: "meal-2" });
    expect(undo(otherSlot).error).toContain("undo_local_only");
    const unbound = recordAs("log_meal", { kind: "log_meal", entryId: ENTRY, baseRev: 3 }, 3, A, {});
    expect(undo(unbound).error).toContain("undo_local_only");
    const wrongRecipe = recordAs("save_recipe", { kind: "save_recipe", recipeId: RECIPE, rev: 1 }, 1, A,
      { name: "Soup" });
    expect(undo(wrongRecipe).error).toContain("undo_local_only");
    // Legacy save_recipe server Undo is phone-only now (spec §5, E2): even the named recipe.
    const recipe = recordAs("save_recipe", { kind: "save_recipe", recipeId: RECIPE, rev: 1 }, 1, A,
      { name: "Egg wrap" });
    expect(undo(recipe).error).toContain("undo_local_only");
    expect(must(`select deleted_at is null from recipes`)).toBe("t");
    expect(must(`select deleted_at is null from log_entries`)).toBe("t");
  });

  it("accepts a composed card's button only when the card offers it, as composedButtons says", () => {
    const items = [{ foodRefId: EGG, grams: 100 }];
    const cards = [
      { wish: "eggs", items, slot: null },
      { wish: "eggs", items, slot: "meal-3" },
      { wish: "eggs", items, slot: null, pendingSlots: [{ slot: "meal-2", label: "x" }] },
      { wish: "eggs", items, slot: null,
        pendingSlots: [{ slot: "meal-2", label: "x" }, { slot: "meal-4", label: "y" }] },
      { wish: "eggs", items: [], slot: "meal-3" },
    ];
    const MSG = "3f1b1a2c-0000-4000-8000-000000000014";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}',
      '${JSON.stringify({ composed: cards })}')`);
    const candidates = ["meal-1", "meal-2", "meal-3", "meal-4"];
    cards.forEach((card, index) => {
      const offers = composedButtons(card as never);
      for (const slot of candidates) {
        const answer = recordVia(`slot-${index}-${slot}`, "set_slot_meal", A, false,
          { inverse: { kind: "set_slot_meal", date: "2026-10-05", slot }, source: [MSG, index] });
        const expected = !offers.kinds.includes("set_slot_meal") ? "kind_mismatch|f"
          : offers.slots.includes(slot) ? "ok|f" : "target_mismatch|f";
        expect(answer, `card ${index} ${slot}`).toBe(expected);
      }
      expect(recordVia(`log-${index}`, "log_meal", A, false, { source: [MSG, index] }))
        .toBe(offers.kinds.includes("log_meal") ? "ok|f" : "kind_mismatch|f");
    });
    expect(must(`select bind->>'slot' from coach_action_undos where action_id = 'log-0'`)).toBe("snack");
  });

  it("a racing undone mark is never lost: the second insert closes the row the first one made", async () => {
    const MSG = "3f1b1a2c-0000-4000-8000-000000000015";
    must(`insert into coach_messages values ('${MSG}', '${THREAD}', '${A}',
      '{"actions":[{"actionId":"race","kind":"save_recipe"}]}')`);
    const slow = spawn(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-At", "-c", `begin; set local role authenticated;
        set local request.jwt.claim.sub = '${A}';
        select record_coach_undo('race', 'save_recipe', '{"kind":"save_recipe"}', null, null, false);
        select pg_sleep(1.2); commit;`], { env: PG_ENV });
    const slowDone = new Promise((resolve) => slow.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Sees no row yet, inserts, waits on the first insert's unique key, then updates it.
    expect(recordVia("race", "save_recipe", A, true)).toBe("ok|t");
    await slowDone;
    expect(must(`select count(*), bool_and(undone_at is not null) from coach_action_undos
      where action_id = 'race'`)).toBe("1|t");
  }, 20_000);

  it("the scrub keeps a meal's entry id and date and empties every other inverse", () => {
    const meal = recordAs("log_meal", { kind: "log_meal", date: "2026-10-05", entryId: ENTRY, baseRev: 3 }, 3);
    const water = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    must(`update coach_action_undos set created_at = now() - interval '9 days',
      expires_at = now() - interval '2 days'`);
    expect(must(`select scrub_coach_action_undos(now() - interval '1 day')`)).toBe("2");
    expect(must(`select inverse::text, expected_rev is null from coach_action_undos where id = '${meal}'`))
      .toBe(`{"date": "2026-10-05", "entryId": "${ENTRY}"}|t`);
    expect(must(`select inverse::text from coach_action_undos where id = '${water}'`)).toBe("{}");
    expect(must(`select scrub_coach_action_undos(now() - interval '1 day')`)).toBe("0");
    expect(sql(`select scrub_coach_action_undos(now())`, A).err).toMatch(/permission denied/);
  });

  it("a scrubbed tombstone stays readable as undone or expired; nothing is deleted", () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    expect(undo(id)).toEqual({ status: "undone" });
    must(`update coach_action_undos set inverse = '{}', expected_rev = null where id = '${id}'`);
    expect(must(`select undone_at is not null, inverse = '{}' from coach_action_undos where id = '${id}'`, A))
      .toBe("t|t");
  });

  it("an expired record refuses the server Undo but can still be marked by the phone", () => {
    const id = recordAs("log_water", { kind: "log_water", date: "2026-10-05", cups: 2, after: 6, afterRev: 2 }, 2);
    must(`alter table coach_action_undos disable trigger coach_action_undos_stamp;
      update coach_action_undos set created_at = now() - interval '8 days',
        expires_at = now() - interval '1 day' where id = '${id}';
      alter table coach_action_undos enable trigger coach_action_undos_stamp;`);
    expect(undo(id)).toEqual({ status: "expired" });
    expect(undo(id, A, true)).toEqual({ status: "undone" });
    expect(undo(id)).toEqual({ status: "already_undone" });
    expect(must(`select cups from water_log`)).toBe("6");
  });

  it("stamps the lifetime itself, whatever the client sends", () => {
    must(`insert into coach_action_undos (user_id, action_id, kind, inverse, created_at, expires_at)
      values ('${A}', 'x', 'log_water', '{}', now() + interval '1 year', now() + interval '2 years')`);
    expect(must(`select expires_at - created_at = interval '7 days', created_at <= now()
      from coach_action_undos where action_id = 'x'`)).toBe("t|t");
  });

  it("is owner-only: no reads, Undos or inserts across accounts, and no client updates at all", () => {
    const id = recordAs("log_meal", { kind: "log_meal", entryId: ENTRY, baseRev: 3 }, 3);
    expect(must(`select count(*) from coach_action_undos`, B)).toBe("0");
    expect(undo(id, B)).toEqual({ status: "not_found" });
    expect(sql(`insert into coach_action_undos (user_id, action_id, kind, inverse)
      values ('${A}', 'y', 'log_meal', '{}')`, B).err).toMatch(/permission denied/);
    expect(sql(`update coach_action_undos set undone_at = now() where id = '${id}'`, A).err)
      .toMatch(/permission denied/);
    expect(sql(`delete from coach_action_undos where id = '${id}'`, A).err).toMatch(/permission denied/);
    expect(must(`select deleted_at is null from log_entries`)).toBe("t");
  });
});
