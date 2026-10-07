/**
 * Phase 18 W5b-2 (docs/specs/phase-18-open-world-foods.md §10 "W5b-2"): the confirm and Undo RPCs
 * (migrations 20261220090000-20261220090200) on a real Postgres. Needs SUPABASE_TEST_DB_URL (a local
 * stack or a branch with every migration applied); skipped without it.
 *
 * The spec's list: overlapping confirms in one tab and in two tabs (the second requesting a key the
 * first added); a confirm against a row another device already changed; a repeated confirm; Undo
 * after a later manual removal; Undo of the second of two overlapping confirms leaves the first's key;
 * the caps; every other diet_prefs key kept; RLS and a two-account check. Plus: the coach record
 * (taste_v1) and its Undo paths, receipt immutability, and the record_coach_undo patch's down/up.
 *
 * Every case but the two-session race runs inside one transaction that is rolled back.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { CUISINES } from "@/lib/profile/cuisines";
import { HAS_DB, pgEnvFromUrl, runSql } from "../helpers/supabase";

const UP = readFileSync("supabase/migrations/20261220090000_taste_chip_receipts.sql", "utf8");
const MODE_UP = readFileSync("supabase/migrations/20261220090100_coach_undo_taste_mode.sql", "utf8");
const MODE_DOWN = readFileSync("supabase/migrations/down/20261220090100_coach_undo_taste_mode.down.sql", "utf8");

describe("the cuisine vocabulary (static)", () => {
  it("the request check's list equals CUISINES", () => {
    const fn = UP.slice(UP.indexOf("create function public._taste_chips_request_valid"));
    const list = /array\[([^\]]*)\]::text\[\]/.exec(fn)?.[1] ?? "";
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...CUISINES]);
  });
});

const A = "a0000000-0000-4000-8000-0000000000a1";
const B = "b0000000-0000-4000-8000-0000000000b2";
const PREFS = {
  flags: ["no_gluten"], text: "no gluten please", water: { unit: "ml", goal: "manual" },
  widget: { ring: "protein" }, taste: { dislikes: ["t:soft"] },
};
const lit = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const arr = (values: readonly string[]) =>
  `array[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")}]::text[]`;
const act = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One rolled-back transaction: two accounts, A with a settings row at rev 3. */
function seeded(...statements: string[]): string[] {
  const sql = [
    "begin;",
    `insert into auth.users (id, email) values ('${A}', 'w5b2-a@meal-companion.test'), ('${B}', 'w5b2-b@meal-companion.test');`,
    `insert into user_settings (user_id, first_opened_at, rev, diet_prefs, cuisines, slot_times)
       values ('${A}', now(), 3, ${lit(PREFS)}, '{italian}', '{"meal_1":"08:00"}'::jsonb);`,
    ...statements,
    "rollback;",
  ].join("\n");
  return runSql(sql).split("\n").filter((line) => line.startsWith("{") || line.startsWith("R:"));
}

const confirmSql = (action: string, dislikes: string[], cuisines: string[], user = A, source = "settings",
  coach = "null") =>
  `select public.taste_chips_confirm('${user}', '${action}', '${source}', ${arr(dislikes)}, ${arr(cuisines)}, ${coach}) - 'settings';`;
const undoSql = (action: string, user = A) => `select public.taste_chips_undo('${user}', '${action}') - 'settings';`;
const rowSql = (user = A) => `select 'R:' || (jsonb_build_object('rev', rev, 'diet_prefs', diet_prefs,
  'cuisines', to_jsonb(cuisines), 'slot_times', slot_times, 'feed',
  (select count(*) from change_log where user_id = '${user}' and entity = 'user_settings')))::text
  from user_settings where user_id = '${user}';`;
const parse = (line: string) => JSON.parse(line.startsWith("R:") ? line.slice(2) : line);
const syncOp = (baseRev: number, payload: unknown) =>
  `select public.apply_sync_op('${A}', jsonb_build_object('op_id', gen_random_uuid(), 'entity', 'user_settings',
     'entity_id', 'settings', 'kind', 'update', 'base_rev', ${baseRev}, 'payload', ${lit(payload)}))->>'status';`;

describe.skipIf(!HAS_DB)("taste_chips_confirm and taste_chips_undo", () => {
  it("adds only missing chips, keeps every other diet_prefs key and column, and feeds the change log", () => {
    const [answer, row] = seeded(confirmSql(act(1), ["t:soft", "t:bitter"], ["italian", "korean"]), rowSql()).map(parse);
    expect(answer).toMatchObject({ status: "applied",
      added: { dislikes: ["t:bitter"], cuisines: ["korean"] },
      present: { dislikes: ["t:soft"], cuisines: ["italian"] }, capped: { dislikes: [], cuisines: [] } });
    expect(row).toEqual({ rev: 4, cuisines: ["italian", "korean"], slot_times: { meal_1: "08:00" }, feed: 1,
      diet_prefs: { ...PREFS, taste: { dislikes: ["t:soft", "t:bitter"] } } });
  });

  it("a repeat of the same action answers the stored receipt and writes nothing; another request is refused", () => {
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], []),
      confirmSql(act(1), ["t:bitter"], []),
      confirmSql(act(1), ["t:spicy_hot"], []),
      confirmSql(act(1), ["t:bitter"], [], A, "onboarding"),
      rowSql(),
    ).map(parse);
    expect(out[0]).toMatchObject({ status: "applied", added: { dislikes: ["t:bitter"] } });
    expect(out[1]).toMatchObject({ status: "existing", added: { dislikes: ["t:bitter"] } });
    expect(out[2]).toEqual({ status: "action_conflict" });
    expect(out[3]).toEqual({ status: "action_conflict" });
    expect(out[4]).toMatchObject({ rev: 4, feed: 1 });
  });

  it("overlapping confirms in one tab: the second adds only what the first did not; Undo of the second leaves the first's key", () => {
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], ["korean"]),
      confirmSql(act(2), ["t:bitter", "t:sour"], ["korean", "japanese"]),
      undoSql(act(2)),
      rowSql(),
    ).map(parse);
    expect(out[1]).toMatchObject({ added: { dislikes: ["t:sour"], cuisines: ["japanese"] },
      present: { dislikes: ["t:bitter"], cuisines: ["korean"] } });
    expect(out[2]).toMatchObject({ status: "undone", removed: { dislikes: ["t:sour"], cuisines: ["japanese"] },
      gone: { dislikes: [], cuisines: [] } });
    expect(out[3].diet_prefs.taste.dislikes).toEqual(["t:soft", "t:bitter"]);
    expect(out[3].cuisines).toEqual(["italian", "korean"]);
  });

  it("a confirm against a row another device already changed reads that row under the lock", () => {
    const otherDevice = { ...PREFS, water: { unit: "oz", goal: "auto" }, taste: { dislikes: ["t:soft", "t:sour"] } };
    const out = seeded(
      `${syncOp(3, { diet_prefs: otherDevice, cuisines: ["italian", "korean"] })}`,
      confirmSql(act(1), ["t:sour", "t:bitter"], ["korean", "african"]),
      rowSql(),
    ).map(parse);
    expect(out[0]).toMatchObject({ added: { dislikes: ["t:bitter"], cuisines: ["african"] },
      present: { dislikes: ["t:sour"], cuisines: ["korean"] } });
    expect(out[1].diet_prefs).toEqual({ ...otherDevice, taste: { dislikes: ["t:soft", "t:sour", "t:bitter"] } });
    expect(out[1].cuisines).toEqual(["italian", "korean", "african"]);
  });

  it("a phone op built before the confirm conflicts instead of overwriting it", () => {
    const out = runSql([
      "begin;",
      `insert into auth.users (id, email) values ('${A}', 'w5b2-a@meal-companion.test');`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs) values ('${A}', now(), 3, ${lit(PREFS)});`,
      confirmSql(act(1), ["t:bitter"], []),
      `select public.apply_sync_op('${A}', jsonb_build_object('op_id', gen_random_uuid(), 'entity', 'user_settings',
         'entity_id', 'settings', 'kind', 'update', 'base_rev', 3, 'payload', ${lit({ diet_prefs: PREFS })}))->>'status';`,
      "rollback;",
    ].join("\n")).split("\n");
    expect(out).toContain("conflict");
  });

  it("Undo after a later manual removal leaves it removed, reports it gone, and writes nothing; a second Undo is a no-op", () => {
    const manual = { ...PREFS, taste: { dislikes: ["t:soft"] } };
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], ["korean"]),
      `${syncOp(4, { diet_prefs: manual })}`,
      rowSql(),
      undoSql(act(1)),
      rowSql(),
      undoSql(act(1)),
      rowSql(),
    ).map(parse);
    expect(out[1]).toMatchObject({ rev: 5, feed: 2 });
    expect(out[2]).toMatchObject({ status: "undone", removed: { dislikes: [], cuisines: ["korean"] },
      gone: { dislikes: ["t:bitter"], cuisines: [] } });
    expect(out[3]).toMatchObject({ rev: 6, feed: 3, cuisines: ["italian"], diet_prefs: manual });
    expect(out[4]).toMatchObject({ status: "already_undone", removed: { dislikes: [], cuisines: ["korean"] },
      gone: { dislikes: ["t:bitter"], cuisines: [] } });
    expect(out[5]).toMatchObject({ rev: 6, feed: 3 });
  });

  it("a key the user removed and added again since is the user's: Undo leaves it and reports it gone", () => {
    const without = { ...PREFS, taste: { dislikes: ["t:soft"] } };
    const again = { ...PREFS, taste: { dislikes: ["t:soft", "t:bitter"] } };
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], ["korean"]),
      `${syncOp(4, { diet_prefs: without, cuisines: ["italian"] })}`,
      `${syncOp(5, { diet_prefs: again, cuisines: ["italian", "korean"] })}`,
      undoSql(act(1)),
      rowSql(),
    ).map(parse);
    expect(out[1]).toMatchObject({ status: "undone", removed: { dislikes: [], cuisines: [] },
      gone: { dislikes: ["t:bitter"], cuisines: ["korean"] } });
    expect(out[2]).toMatchObject({ rev: 6, feed: 3, diet_prefs: again, cuisines: ["italian", "korean"] });
  });

  it("an unrelated edit keeps the hold: Undo still removes the key", () => {
    const water = { ...PREFS, water: { unit: "oz" }, taste: { dislikes: ["t:soft", "t:bitter"] } };
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], []),
      `${syncOp(4, { diet_prefs: water, slot_times: { meal_1: "09:00" } })}`,
      undoSql(act(1)),
      rowSql(),
    ).map(parse);
    expect(out[1]).toMatchObject({ removed: { dislikes: ["t:bitter"] }, gone: { dislikes: [] } });
    expect(out[2].diet_prefs).toEqual({ ...water, taste: { dislikes: ["t:soft"] } });
  });

  it("deleting the settings row ends every hold: a key added back on a new row is the user's", () => {
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], []),
      `delete from user_settings where user_id = '${A}';`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs) values ('${A}', now(), 1,
         ${lit({ taste: { dislikes: ["t:bitter"] } })});`,
      undoSql(act(1)),
    ).map(parse);
    expect(out[1]).toMatchObject({ status: "undone", removed: { dislikes: [] }, gone: { dislikes: ["t:bitter"] } });
  });

  it("Undo with every added key gone writes nothing", () => {
    const out = seeded(
      confirmSql(act(1), ["t:bitter"], []),
      `${syncOp(4, { diet_prefs: PREFS })}`,
      undoSql(act(1)),
      rowSql(),
    ).map(parse);
    expect(out[1]).toMatchObject({ removed: { dislikes: [] }, gone: { dislikes: ["t:bitter"] } });
    expect(out[2]).toMatchObject({ rev: 5, feed: 2 });
  });

  it("never passes 50 dislikes or 6 cuisines; at the cap nothing is written and the receipt adds nothing", () => {
    const fortyNine = Array.from({ length: 49 }, (_, i) => `f:food ${i}`);
    const out = runSql([
      "begin;",
      `insert into auth.users (id, email) values ('${A}', 'w5b2-a@meal-companion.test');`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs, cuisines) values ('${A}', now(), 1,
         ${lit({ taste: { dislikes: fortyNine } })}, '{american,italian,korean,chinese,japanese}');`,
      confirmSql(act(1), ["t:bitter", "t:sour", "f:food 3"], ["african", "caribbean"]),
      confirmSql(act(2), ["t:spicy_hot"], ["european_other"]),
      rowSql(),
      undoSql(act(2)),
      undoSql(act(1)),
      rowSql(),
      "rollback;",
    ].join("\n")).split("\n").filter((line) => line.startsWith("{") || line.startsWith("R:")).map(parse);
    expect(out[0]).toMatchObject({ added: { dislikes: ["t:bitter"], cuisines: ["african"] },
      present: { dislikes: ["f:food 3"], cuisines: [] }, capped: { dislikes: ["t:sour"], cuisines: ["caribbean"] } });
    expect(out[1]).toMatchObject({ status: "applied", added: { dislikes: [], cuisines: [] },
      capped: { dislikes: ["t:spicy_hot"], cuisines: ["european_other"] } });
    expect(out[2].diet_prefs.taste.dislikes).toHaveLength(50);
    expect(out[2].cuisines).toHaveLength(6);
    expect(out[2]).toMatchObject({ rev: 2, feed: 1 });
    expect(out[3]).toMatchObject({ status: "undone", removed: { dislikes: [], cuisines: [] } });
    expect(out[4]).toMatchObject({ removed: { dislikes: ["t:bitter"], cuisines: ["african"] } });
    expect(out[5].diet_prefs.taste.dislikes).toEqual(fortyNine);
    expect(out[5]).toMatchObject({ rev: 3, feed: 2 });
  });

  it("refuses malformed requests (22023) and answers settings_not_synced without a row", () => {
    for (const statement of [
      confirmSql(act(1), ["t:nope"], []), confirmSql(act(1), [], []), confirmSql(act(1), [], ["martian"]),
      confirmSql(act(1), ["t:soft", "t:soft"], []), confirmSql(act(1), [], ["korean", "korean"]),
      confirmSql(act(1), ["t:soft"], [], A, "jev"), confirmSql(act(1), ["t:soft"], [], A, "coach"),
    ]) {
      expect(() => seeded(statement)).toThrow(/bad_chips|bad_source|bad_coach/);
    }
    expect(seeded(confirmSql(act(1), ["t:soft"], [], B)).map(parse)).toEqual([{ status: "settings_not_synced" }]);
  });

  it("the receipt is immutable except its one Undo transition", () => {
    expect(() => seeded(confirmSql(act(1), ["t:bitter"], []),
      `update taste_chip_receipts set added_dislikes = '{}' where action_id = '${act(1)}';`))
      .toThrow(/taste_receipt_immutable/);
    expect(() => seeded(confirmSql(act(1), ["t:bitter"], []), undoSql(act(1)),
      `update taste_chip_receipts set undone_at = now(), removed_dislikes = '{}', removed_cuisines = '{}',
         gone_dislikes = '{}', gone_cuisines = '{}' where action_id = '${act(1)}';`))
      .toThrow(/taste_receipt_immutable/);
  });
});

/** As the signed-in account (`auth.uid()`), for RLS and the coach functions. */
const as = (user: string) =>
  `select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true); set local role authenticated;`;

describe.skipIf(!HAS_DB)("RLS and two accounts", () => {
  it("owner-only reads; no client writes; no confirm or Undo for another account", () => {
    const out = runSql([
      "begin;",
      `insert into auth.users (id, email) values ('${A}', 'w5b2-a@meal-companion.test'), ('${B}', 'w5b2-b@meal-companion.test');`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs) values ('${A}', now(), 1, '{}'), ('${B}', now(), 1, '{}');`,
      as(A),
      confirmSql(act(1), ["t:bitter"], []),
      `select 'A sees ' || count(*) from taste_chip_receipts;`,
      "reset role;",
      as(B),
      `select 'B sees ' || count(*) from taste_chip_receipts;`,
      `select 'B undo ' || (public.taste_chips_undo('${B}', '${act(1)}')->>'status');`,
      "reset role;",
      `select 'A rev ' || rev || ' ' || (diet_prefs->'taste'->>'dislikes') from user_settings where user_id = '${A}';`,
      "rollback;",
    ].join("\n")).split("\n");
    expect(out).toEqual(expect.arrayContaining(["A sees 1", "B sees 0", "B undo not_found", 'A rev 2 ["t:bitter"]']));
    for (const forbidden of [
      `${as(B)} ${confirmSql(act(2), ["t:bitter"], [], A)}`,
      `${as(B)} ${undoSql(act(1), A)}`,
    ]) {
      expect(() => seeded(confirmSql(act(1), ["t:bitter"], []), forbidden)).toThrow(/forbidden/);
    }
    for (const write of [
      `insert into taste_chip_receipts (user_id, action_id, source, requested_dislikes, requested_cuisines,
         added_dislikes, added_cuisines, present_dislikes, present_cuisines, capped_dislikes, capped_cuisines)
         values ('${A}', '${act(9)}', 'settings', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}');`,
      `update taste_chip_receipts set undone_at = now();`,
      `delete from taste_chip_receipts;`,
      `select public._taste_chips_undo_locked('${A}', '${act(1)}');`,
      `select * from taste_chip_holds;`,
      `delete from taste_chip_holds;`,
    ]) {
      expect(() => seeded(confirmSql(act(1), ["t:bitter"], []), as(A), write)).toThrow(/permission denied/);
    }
  });
});

describe.skipIf(!HAS_DB)("the coach card: one record, undone from the receipt only", () => {
  const MESSAGE = "c0000000-0000-4000-8000-0000000000c3";
  const card = { kind: "taste_chips_proposal", v: 1, id: "p1",
    dislikes: [{ key: "t:bitter", label: "Bitter", p: 0.9 }, { key: "t:sour", label: "Sour", p: 0.85 }],
    cuisines: [{ key: "korean", label: "Korean", p: 0.95 }] };
  const thread = [
    `insert into coach_threads (id, user_id, kind) values ('${MESSAGE}', '${A}', 'chat');`,
    `insert into coach_messages (id, user_id, thread_id, role, content, seq, tool_calls)
       values ('${MESSAGE}', '${A}', '${MESSAGE}', 'assistant', 'ok', 1, ${lit({ tasteChips: card })});`,
  ];
  const coach = (proposalId = "p1", messageId = MESSAGE) => lit({ messageId, proposalId });
  const record = `select 'REC ' || record_mode || ' ' || kind || ' ' || coalesce(undone_at::text, 'open')
    from coach_action_undos where action_id = '${act(1)}';`;
  const recordId = `(select id from coach_action_undos where action_id = '${act(1)}')`;

  function withThread(...statements: string[]): string[] {
    return runSql(["begin;",
      `insert into auth.users (id, email) values ('${A}', 'w5b2-a@meal-companion.test'), ('${B}', 'w5b2-b@meal-companion.test');`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs) values ('${A}', now(), 1, '{}');`,
      ...thread, ...statements, "rollback;"].join("\n")).split("\n");
  }

  it("confirms only chips the card offered, on the caller's own message, and writes a taste_v1 record", () => {
    const out = withThread(
      confirmSql(act(1), ["t:bitter"], ["korean"], A, "coach", coach()),
      record,
      confirmSql(act(2), ["t:spicy_hot"], [], A, "coach", coach()),
      confirmSql(act(3), ["t:bitter"], [], A, "coach", coach("p2")),
      confirmSql(act(4), ["t:bitter"], [], A, "coach", coach("p1", act(77))),
    );
    expect(out.find((l) => l.startsWith("{"))).toContain('"status": "applied"');
    expect(out).toContain("REC taste_v1 confirm_taste_chips open");
    expect(out.filter((l) => l.startsWith("{")).slice(1).map((l) => JSON.parse(l).status))
      .toEqual(["chip_not_proposed", "unknown_proposal", "unknown_proposal"]);
  });

  it("perform_coach_undo undoes from the receipt and closes the record; local and legacy closes are refused", () => {
    const out = withThread(
      confirmSql(act(1), ["t:bitter"], ["korean"], A, "coach", coach()),
      as(A),
      `select 'UNDO ' || (public.perform_coach_undo(${recordId})->>'status');`,
      `select 'AGAIN ' || (public.perform_coach_undo(${recordId})->>'status');`,
      "reset role;",
      record,
      `select 'TASTE ' || (public.taste_chips_undo('${A}', '${act(1)}')->>'status');`,
      `select 'ROW ' || (diet_prefs->'taste'->>'dislikes') || ' ' || cuisines::text from user_settings where user_id = '${A}';`,
    );
    expect(out).toEqual(expect.arrayContaining(["UNDO undone", "AGAIN already_undone", "TASTE already_undone",
      "ROW [] {}"]));
    expect(out.some((l) => /^REC taste_v1 confirm_taste_chips \d{4}-/.test(l))).toBe(true);
    for (const close of [
      `select public.perform_coach_undo(${recordId}, true);`,
      `select public.record_coach_undo('${act(1)}', 'confirm_taste_chips', '{}'::jsonb, null, null, true);`,
    ]) {
      expect(() => withThread(confirmSql(act(1), ["t:bitter"], [], A, "coach", coach()), as(A), close))
        .toThrow(/undo_receipt_record/);
    }
    const recorded = withThread(as(A),
      `select 'REC ' || (public.record_coach_undo('${act(5)}', 'confirm_taste_chips', '{}'::jsonb, null, null, false,
         '${MESSAGE}', 0)->>'status');`);
    expect(recorded).toContain("REC kind_mismatch");
  });

  it("the taste route's Undo closes the coach record too; another account cannot undo it", () => {
    const out = withThread(
      confirmSql(act(1), ["t:sour"], [], A, "coach", coach()),
      undoSql(act(1)),
      record,
      as(A),
      `select 'COACH ' || (public.perform_coach_undo(${recordId})->>'status');`,
      "reset role;", as(B),
      `select 'B ' || (public.perform_coach_undo(${recordId})->>'status');`,
    );
    expect(out.some((l) => /^REC taste_v1 confirm_taste_chips \d{4}-/.test(l))).toBe(true);
    expect(out).toEqual(expect.arrayContaining(["COACH already_undone", "B not_found"]));
  });

  it("the record's mode and kind are tied both ways", () => {
    expect(() => withThread(`insert into coach_action_undos (user_id, action_id, kind, inverse)
      values ('${A}', 'x', 'confirm_taste_chips', '{}');`)).toThrow(/coach_action_undos_taste_mode/);
    expect(() => withThread(`insert into coach_action_undos (user_id, action_id, kind, inverse, record_mode)
      values ('${A}', 'x', 'log_water', '{}', 'taste_v1');`)).toThrow(/coach_action_undos_taste_mode/);
  });

  it("the record_coach_undo patch: up is a no-op when applied, down then up restores it byte for byte", () => {
    const def = "select md5(pg_get_functiondef('public.record_coach_undo(text,text,jsonb,bigint,uuid,boolean,uuid,integer)'::regprocedure));";
    const out = runSql(["begin;", def, MODE_UP.replace(/alter table[\s\S]*?not valid;\n/g, ""), def, MODE_DOWN, def,
      MODE_UP, def, "rollback;"].join("\n")).split("\n").filter((line) => /^[0-9a-f]{32}$/.test(line));
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(out[1]);
    expect(out[3]).toBe(out[0]);
    expect(out[2]).not.toBe(out[0]);
  });
});

/** Two sessions at once, committed (the lock is the point), cleaned up after. */
function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
      { env: { ...process.env, ...pgEnvFromUrl(process.env.SUPABASE_TEST_DB_URL ?? "") } });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
  });
}

describe.skipIf(!HAS_DB)("two tabs at once", () => {
  const user = randomUUID();
  afterAll(() => { if (HAS_DB) runSql(`delete from auth.users where id = '${user}';`); });

  it("the second confirm waits for the first, sees its key as present, and Undo of the second leaves it", async () => {
    runSql([`insert into auth.users (id, email) values ('${user}', 'w5b2-race-${user}@meal-companion.test');`,
      `insert into user_settings (user_id, first_opened_at, rev, diet_prefs) values ('${user}', now(), 1, '{}');`].join("\n"));
    const first = psqlAsync(["begin;", confirmSql(act(1), ["t:bitter"], [], user),
      "select pg_sleep(1.5);", "commit;"].join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = Date.now();
    const second = await psqlAsync(confirmSql(act(2), ["t:bitter", "t:sour"], [], user));
    expect(Date.now() - started).toBeGreaterThan(500);
    const firstAnswer = JSON.parse((await first).split("\n").find((l) => l.startsWith("{")) ?? "{}");
    expect(firstAnswer.added).toEqual({ dislikes: ["t:bitter"], cuisines: [] });
    expect(JSON.parse(second).added).toEqual({ dislikes: ["t:sour"], cuisines: [] });
    expect(JSON.parse(second).present).toEqual({ dislikes: ["t:bitter"], cuisines: [] });
    runSql(undoSql(act(2), user));
    expect(runSql(`select diet_prefs->'taste'->>'dislikes' from user_settings where user_id = '${user}';`))
      .toBe('["t:bitter"]');
  }, 20_000);
});
