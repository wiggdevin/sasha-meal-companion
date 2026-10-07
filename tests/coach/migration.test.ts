import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const up = (f: string) => readFileSync(path.join(root, "supabase/migrations", f), "utf8");
const down = (f: string) => readFileSync(path.join(root, "supabase/migrations/down", f), "utf8");

const COACH = "20261001000000_phase7_coach.sql";
const SCOPES = "20261003000000_phase7_token_scopes.sql";

describe("the Phase 7 migrations", () => {
  it("only ALTERs the three Phase 0 tables — it never recreates them", () => {
    const sql = up(COACH);
    expect(sql).not.toMatch(/create table (if not exists )?coach_threads/i);
    expect(sql).not.toMatch(/create table (if not exists )?coach_messages/i);
    expect(sql).not.toMatch(/create table (if not exists )?constraint_profiles/i);
  });

  it("adds every column contracts §4 names", () => {
    const sql = up(COACH);
    for (const column of ["kind", "rev", "last_message_at", "deleted_at"]) {
      expect(sql).toContain(`alter table coach_threads add column ${column}`);
    }
    for (const column of ["user_id", "deflected", "model_id", "ai_call_id", "seq"]) {
      expect(sql).toContain(`alter table coach_messages add column ${column}`);
    }
    expect(sql).toContain("alter table constraint_profiles add column updated_at");
  });

  it("backfills coach_messages.user_id and seq before making them not null", () => {
    const sql = up(COACH);
    expect(sql.indexOf("update coach_messages m set user_id")).toBeGreaterThan(-1);
    expect(sql.indexOf("update coach_messages m set user_id"))
      .toBeLessThan(sql.indexOf("alter column user_id set not null"));
    expect(sql.indexOf("row_number() over"))
      .toBeLessThan(sql.indexOf("alter column seq set not null"));
  });

  it("adds the one-weekly partial unique index and the seq uniqueness", () => {
    const sql = up(COACH);
    expect(sql).toContain("create unique index coach_threads_one_weekly on coach_threads (user_id)");
    expect(sql).toContain("where kind = 'weekly_review' and deleted_at is null");
    expect(sql).toContain("add constraint coach_messages_thread_seq unique (thread_id, seq)");
  });

  it("does NOT widen ai_calls.purpose — Phase 0 shipped the column with no check", () => {
    expect(up(COACH)).not.toMatch(/ai_calls_purpose_check/);
  });

  it("widens the token scope vocabulary to exactly three values", () => {
    expect(up(SCOPES)).toContain(
      "check (scopes <@ array['read','log:write','constraints:write']::text[])"
    );
  });

  it("has a down file for each up file that drops only what it created", () => {
    expect(down("20261001000000_phase7_coach.down.sql")).toContain("drop column if exists seq");
    expect(down("20261001000000_phase7_coach.down.sql")).not.toMatch(/drop table/i);
    expect(down("20261003000000_phase7_token_scopes.down.sql"))
      .toContain("drop constraint if exists api_tokens_scopes_known");
  });
});
