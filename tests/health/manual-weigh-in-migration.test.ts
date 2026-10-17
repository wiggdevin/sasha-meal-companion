/**
 * T8 §2, the write path: `health_weigh_in`.
 *
 * This runs the real function against a real database, inside a transaction it rolls back. The
 * first round asserted the migration's TEXT — that it contained "security definer", that it
 * granted execute to `authenticated` — and Grok was right that such a test cannot fail for any
 * reason that matters: the words can all be present and the function still let anyone write
 * anyone's weight. So the whole suite below runs AS her (`set role authenticated`, with
 * `request.jwt.claims` supplying `auth.uid()`) and asserts what actually happens. The only text
 * assertions left are on the down file, which nothing applies here.
 *
 * Skips loudly without SUPABASE_TEST_DB_URL, like tests/water/migration.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261019090000_manual_weigh_in";
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OURA = "33333333-3333-4333-8333-333333333333";
const TZ = "America/Los_Angeles";
const SIG = "health_weigh_in(date,text,numeric)";

const user = (id: string, email: string) =>
  `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
     created_at, updated_at)
   values ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           '${email}', 'x', now(), now());`;

/** Signed in as `id`, with the privileges of a browser session and nothing more. */
const signIn = (id: string) => [
  "reset role;",
  `set local request.jwt.claims = '{"sub":"${id}","role":"authenticated"}';`,
  "set local role authenticated;",
].join("\n");

/**
 * Returns a marker instead of aborting the transaction: a refusal is the thing under test.
 * `try_source` runs as the owner: since W018 (20261231170000) a session has no insert on
 * health_sources at all, and what it checks is the one-manual-source index behind that.
 */
const HELPERS = `
create function pg_temp.try_weigh(d date, z text, k numeric) returns text
  language plpgsql as $f1$ begin
    perform * from health_weigh_in(d, z, k);
    return 'accepted';
  exception when others then return 'refused:' || sqlerrm;
  end $f1$;
create function pg_temp.try_source(u uuid) returns text
  language plpgsql security definer as $f2$ begin
    insert into health_sources (user_id, kind) values (u, 'manual');
    return 'allowed';
  exception when unique_violation then return 'refused:one_manual';
  end $f2$;`;

const scenario = [
  "begin;",
  user(A, "t8-a@meal-companion.test"),
  user(B, "t8-b@meal-companion.test"),
  HELPERS,
  signIn(A),

  // What a browser session may and may not do. `health_samples` is read-only to her, which is the
  // whole reason this RPC exists; the RPC's own `security definer` is what gets past it.
  `select 'cannot_insert:' || has_table_privilege('authenticated','health_samples','insert');`,
  `select 'can_exec:' || has_function_privilege('authenticated','${SIG}','execute');`,
  `select 'anon_exec:' || has_function_privilege('anon','${SIG}','execute');`,

  // 170 lb is 77.111 kg, stamped 07:00 local on the day she named.
  `select 'typed:' || kg from health_weigh_in('2026-09-17', '${TZ}', 77.111);`,
  `select 'stamp:' || to_char(start_time at time zone '${TZ}', 'YYYY-MM-DD HH24:MI')
     || '|' || vendor_sample_id || '|' || unit || '|' || type
     from health_samples where type = 'body_mass';`,
  // 171 lb the same morning: a correction, not a second row.
  `select 'retyped:' || kg from health_weigh_in('2026-09-17', '${TZ}', 77.564);`,
  `select 'after_second:' || count(*) || '|' || max(value)
     from health_samples where type = 'body_mass';`,

  // One manual source, enforced by the index rather than hoped for by the lookup. `reuse` names a
  // day well in the past, so it cannot collide with the "tomorrow is accepted" case below.
  `select 'dup_source:' || pg_temp.try_source('${A}');`,
  `select 'reuse:' || kg from health_weigh_in('2026-09-15', '${TZ}', 77.2);`,
  `select 'a_sources:' || count(*) from health_sources where kind = 'manual';`,

  // Every refusal, and tomorrow still accepted.
  `select 'interval_tz:' || pg_temp.try_weigh('2026-09-17', '15:00', 77.1);`,
  `select 'unknown_tz:' || pg_temp.try_weigh('2026-09-17', 'Mars/Olympus', 77.1);`,
  // The range's edges to the gram, the same four numbers lib/today/weight-input.ts holds the field
  // to. Each on its own past day, so none of them corrects another.
  `select 'edge_low_in:' || pg_temp.try_weigh('2026-09-14', '${TZ}', 20.000);`,
  `select 'edge_high_in:' || pg_temp.try_weigh('2026-09-13', '${TZ}', 400.000);`,
  `select 'edge_low_out:' || pg_temp.try_weigh('2026-09-12', '${TZ}', 19.999);`,
  `select 'edge_high_out:' || pg_temp.try_weigh('2026-09-11', '${TZ}', 400.001);`,
  `select 'low:' || pg_temp.try_weigh('2026-09-17', '${TZ}', 4.536);`,
  `select 'high:' || pg_temp.try_weigh('2026-09-17', '${TZ}', 500);`,
  `select 'ahead:' || pg_temp.try_weigh((now() at time zone '${TZ}')::date + 2, '${TZ}', 77.1);`,
  `select 'tomorrow:' || pg_temp.try_weigh((now() at time zone '${TZ}')::date + 1, '${TZ}', 77.1);`,
  // The estimator's view sees a typed row like any other (AC6).
  `select 'weigh_ins:' || count(*) || '|' || max(value)
     from weigh_ins where local_date = '2026-09-17';`,

  // A scale reading for the same day, written the way ingest writes it.
  "reset role;",
  `insert into health_sources (id, user_id, kind, device_label)
     values ('${OURA}', '${A}', 'oura', 'Oura');`,
  `insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
                               vendor_sample_id)
     values ('${A}', '${OURA}', 'body_mass', 80, 'kg',
             timestamptz '2026-09-17 06:00 ${TZ}', timestamptz '2026-09-17 06:00 ${TZ}',
             '${TZ}', 'oura:2026-09-17');`,
  `select 'merged:' || body_mass_kg from daily_health
     where user_id = '${A}' and local_date = '2026-09-17';`,
  `select 'merged_manual_day:' || body_mass_kg from daily_health
     where user_id = '${A}' and local_date = '2026-09-15';`,

  // The other account: same function, her own row, and A's neither seen nor touched.
  signIn(B),
  `select 'b_typed:' || kg from health_weigh_in('2026-09-17', '${TZ}', 60);`,
  `select 'b_rows:' || count(*) from health_samples where user_id = '${B}';`,
  `select 'b_sees_a:' || count(*) from health_samples where user_id = '${A}';`,
  "reset role;",
  `select 'a_rows:' || count(*) from health_samples where user_id = '${A}';`,

  // The rollback file, applied for real. Asserting its TEXT proves nothing about what it does; this
  // runs it and then asks the database. Still inside the transaction, so nothing survives.
  DOWN,
  `select 'down_fn:' || pg_temp.try_weigh('2026-09-17', '${TZ}', 77.1);`,
  // The old view rule is "latest sample of the local day", whatever wrote it — so her 07:00 manual
  // row now outranks the 06:00 Oura one it lost to a moment ago.
  `select 'down_merged:' || body_mass_kg from daily_health
     where user_id = '${A}' and local_date = '2026-09-17';`,
  // And the one-manual-source index is gone with it.
  `select 'down_dup_source:' || pg_temp.try_source('${B}');`,
  "rollback;",
].join("\n");

describe.skipIf(!HAS_DB)(`${NAME} against a real database`, () => {
  const out = HAS_DB ? runSql(scenario) : "";

  it("lets her write a weigh-in she has no table privilege to insert", () => {
    expect(out).toContain("cannot_insert:false");
    expect(out).toContain("can_exec:true");
    expect(out).toContain("anon_exec:false");
    expect(out).toContain("typed:77.111");
  });

  it("stamps 07:00 of the day she named, in her zone, keyed on that day", () => {
    expect(out).toContain("stamp:2026-09-17 07:00|manual:2026-09-17|kg|body_mass");
  });

  it("corrects the day rather than adding a second row", () => {
    expect(out).toContain("retyped:77.564");
    expect(out).toContain("after_second:1|77.564");
  });

  /**
   * The race a lookup-then-insert loses: two first-time weigh-ins both read no source, both insert,
   * and the day ends with two sources and therefore two samples. True simultaneity is not
   * reproducible through a one-connection psql harness, so what is asserted is the thing that makes
   * the race safe — the partial unique index refuses the second row — and that the function is
   * happy to run against a source it did not create.
   */
  it("allows exactly one manual source per account", () => {
    expect(out).toContain("dup_source:refused:one_manual");
    expect(out).toContain("reuse:77.2");
    expect(out).toContain("a_sources:1");
  });

  /**
   * `at time zone` accepts an interval-shaped string, so '15:00' was read as a fixed +15:00 offset:
   * the sample silently landed on a different local day and `bad_tz` never fired. Only a check
   * against the tz database's own names separates a zone from a number.
   */
  it("refuses an interval dressed up as a time zone", () => {
    expect(out).toContain("interval_tz:refused:bad_tz");
    expect(out).toContain("unknown_tz:refused:bad_tz");
  });

  /** The range's own edges: 20.000 kg and 400.000 kg are hers, one gram outside either is not. */
  it("holds the range to the gram", () => {
    expect(out).toContain("edge_low_in:accepted");
    expect(out).toContain("edge_high_in:accepted");
    expect(out).toContain("edge_low_out:refused:weight_out_of_range");
    expect(out).toContain("edge_high_out:refused:weight_out_of_range");
  });

  it("refuses a weight outside 20-400 kg and a day more than one ahead", () => {
    expect(out).toContain("low:refused:weight_out_of_range");
    expect(out).toContain("high:refused:weight_out_of_range");
    expect(out).toContain("ahead:refused:future_date");
    // Tomorrow is not the future she has to be protected from: she may be a zone ahead of the
    // server, or typing just before midnight.
    expect(out).toContain("tomorrow:accepted");
  });

  it("reaches the estimator's weigh_ins view", () => {
    expect(out).toContain("weigh_ins:1|77.564");
  });

  it("lets a scale reading outrank her typed one on the same day, and only that day", () => {
    expect(out).toContain("merged:80");
    expect(out).toContain("merged_manual_day:77.2");
  });

  /**
   * Applied, not read. The down file's job is that the database goes back to what it was: the RPC
   * gone, `daily_health` back to "latest sample of the local day" whatever wrote it, and the
   * one-manual-source index lifted.
   */
  it("goes back, when the down file is applied", () => {
    expect(out).toContain("down_fn:refused:function health_weigh_in(date, text, numeric) does not exist");
    // Her 07:00 manual row beats the 06:00 Oura one again, which is the pre-T8 rule exactly.
    expect(out).toContain("down_merged:77.564");
    expect(out).toContain("down_dup_source:allowed");
  });

  it("files every row under the caller, who can neither see nor touch another account's", () => {
    expect(out).toContain("b_typed:60");
    expect(out).toContain("b_rows:1");
    expect(out).toContain("b_sees_a:0");
    // Her three manual days (the 17th, the 15th, and tomorrow) plus the Oura reading; B's
    // weigh-in did not land here.
    expect(out).toContain("a_rows:6");
  });
});

describe(`${NAME}.down.sql`, () => {
  it("leaves every sample where it is — they are real weigh-ins, whoever wrote them", () => {
    expect(DOWN).not.toContain("delete from health_samples");
    expect(DOWN).not.toContain("drop table");
  });
});
