import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261023090000_target_authority";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");
const APPROVAL_NAME = "20261023090500_approve_proposal_via_revision";
const APPROVAL_UP_PATH = `supabase/migrations/${APPROVAL_NAME}.sql`;
const APPROVAL_DOWN_PATH = `supabase/migrations/down/${APPROVAL_NAME}.down.sql`;
const APPROVAL_UP = existsSync(APPROVAL_UP_PATH) ? readFileSync(APPROVAL_UP_PATH, "utf8") : "";
const APPROVAL_DOWN = existsSync(APPROVAL_DOWN_PATH)
  ? readFileSync(APPROVAL_DOWN_PATH, "utf8")
  : "";
const TRANSACTION_NAME = "20261023091000_target_revision_transactions";
const TRANSACTION_UP = readFileSync(`supabase/migrations/${TRANSACTION_NAME}.sql`, "utf8");
const TRANSACTION_DOWN = readFileSync(
  `supabase/migrations/down/${TRANSACTION_NAME}.down.sql`, "utf8");

const COLUMNS = [
  "target_source",
  "training_macros",
  "rest_macros",
  "pin_training_kcal",
  "pin_rest_kcal",
  "pin_protein_g",
  "input_weight_kg",
  "input_weight_source",
  "input_training_weekdays",
  "input_activity_level",
  "input_goal",
  "formula_name",
];

describe(`${NAME}.sql`, () => {
  it("adds one nullable authority contract to the existing target_profiles table", () => {
    expect(UP).toContain("alter table target_profiles");
    for (const column of COLUMNS) {
      expect(UP).toContain(`add column ${column}`);
      expect(UP).not.toMatch(new RegExp(`add column ${column}[^,;]*not null`, "i"));
    }
    expect(UP).toContain("target_source in ('derived','proposal','manual')");
    expect(UP).toContain("input_weight_source in ('weigh-in','onboarding')");
  });

  it("writes a monotonically increasing revision and a target_profiles change-feed row atomically", () => {
    expect(UP).toContain("create function write_target_revision");
    expect(UP).toContain("coalesce(max(rev), 0) + 1");
    expect(UP).toContain("insert into change_log");
    expect(UP).toContain("'target_profiles'");
    expect(UP).toContain("grant execute on function write_target_revision(uuid, jsonb)");
  });

  it("marks approved adaptive proposals as proposal revisions with their inputs", () => {
    expect(UP).toContain("create or replace function approve_target_proposal");
    expect(UP).toContain("'proposal'");
    expect(UP).toContain("'adaptive-expenditure-v1'");
    expect(UP).toContain("input_weight_kg");
  });

  it("down restores the prior approval RPC before dropping only the new columns", () => {
    expect(DOWN.indexOf("create or replace function approve_target_proposal"))
      .toBeLessThan(DOWN.indexOf("alter table target_profiles"));
    expect(DOWN).toContain("drop function if exists write_target_revision(uuid, jsonb)");
    for (const column of COLUMNS) expect(DOWN).toContain(`drop column ${column}`);
    expect(DOWN).not.toContain("drop table target_profiles");
  });
});

describe(`${APPROVAL_NAME}.sql`, () => {
  it("routes proposal approval through the one target revision writer", () => {
    expect(APPROVAL_UP).toMatch(/write_target_revision\s*\(\s*p_user_id\s*,\s*v_payload\s*\)/i);
    expect(APPROVAL_UP).not.toMatch(/insert\s+into\s+target_profiles/i);
  });

  it("keeps the authored carb floor, with the 100 g floor as its fallback", () => {
    expect(APPROVAL_UP).toContain("coalesce(v_active.carb_g_min, 100)");
  });

  it("down restores the replaced direct-insert definition", () => {
    expect(APPROVAL_DOWN).toMatch(/insert\s+into\s+target_profiles/i);
    expect(APPROVAL_DOWN).not.toMatch(/write_target_revision\s*\(/i);
  });
});

describe(`${TRANSACTION_NAME}.sql`, () => {
  it("writes the predecessor and real revision inside one RPC transaction", () => {
    expect(TRANSACTION_UP).toContain("create function write_target_revision_pair");
    expect(TRANSACTION_UP).toContain("write_target_revision(p_user_id, p_predecessor)");
    expect(TRANSACTION_UP).toContain("write_target_revision(p_user_id, p_row)");
    expect(TRANSACTION_UP).toContain("jsonb_build_object('predecessor'");
  });

  it("deduplicates queued target retries through the change-log request id", () => {
    expect(TRANSACTION_UP).toContain("p_row->>'request_id'");
    expect(TRANSACTION_UP).toContain("op_id = v_request_id");
    expect(TRANSACTION_UP).toContain("v_request_id, to_jsonb(v_profile)");
  });

  it("down removes the pair RPC and restores the prior single-row writer", () => {
    expect(TRANSACTION_DOWN).toContain(
      "drop function if exists write_target_revision_pair(uuid, jsonb, jsonb)");
    expect(TRANSACTION_DOWN).not.toContain("p_row->>'request_id'");
  });
});

describe.skipIf(!(HAS_BRANCH && HAS_DB))(`${NAME} on a live branch`, () => {
  it("writes sequential revisions, preserves explicit null pins, and rolls back cleanly", async () => {
    const user = await ensureUser("b");
    const payload = (trainingKcal: number | null) => JSON.stringify({
      effective_from: "2026-09-19",
      target_source: "manual",
      training_macros: { kcal: trainingKcal ?? 2100, protein: 120, carbs: 225, fat: 80 },
      rest_macros: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
      pin_training_kcal: trainingKcal,
      pin_rest_kcal: null,
      pin_protein_g: null,
      input_weight_kg: 60,
      input_weight_source: "onboarding",
      input_training_weekdays: [1, 3, 4, 5],
      input_activity_level: "moderate",
      input_goal: "recomp",
      formula_name: "profile-energy-v1",
    }).replaceAll("'", "''");
    const signIn = [
      `set local request.jwt.claims = '{"sub":"${user.id}","role":"authenticated"}';`,
      "set local role authenticated;",
    ].join("\n");
    const sql = [
      "begin;",
      DOWN,
      `delete from target_profiles where user_id = '${user.id}';`,
      `delete from change_log where user_id = '${user.id}' and entity = 'target_profiles';`,
      UP,
      signIn,
      `select 'u1_first:' || (write_target_revision('${user.id}',`,
      `'${payload(2300)}'::jsonb)->>'rev');`,
      `select 'u1_second:' || (write_target_revision('${user.id}',`,
      `'${payload(null)}'::jsonb)->>'rev');`,
      "reset role;",
      `select 'u1_row:' || rev || '|' || coalesce(pin_training_kcal::text, 'null') || '|'`,
      `  || (training_macros->>'kcal') from target_profiles where user_id = '${user.id}'`,
      "  order by rev desc limit 1;",
      `select 'u1_feed:' || count(*) from change_log where user_id = '${user.id}'`,
      "  and entity = 'target_profiles';",
      DOWN,
      "select 'u1_columns:' || count(*) from information_schema.columns",
      "  where table_name = 'target_profiles'",
      `  and column_name in (${COLUMNS.map((column) => `'${column}'`).join(",")});`,
      "select 'u1_writer:' || count(*) from pg_proc where proname = 'write_target_revision';",
      "rollback;",
    ].join("\n");

    const out = runSql(sql);
    expect(out).toContain("u1_first:1");
    expect(out).toContain("u1_second:2");
    expect(out).toContain("u1_row:2|null|2100");
    expect(out).toContain("u1_feed:2");
    expect(out).toContain("u1_columns:0");
    expect(out).toContain("u1_writer:0");
  });
});
