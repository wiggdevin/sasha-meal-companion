import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261024093300_activity_prompt_dismissal";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql`, () => {
  it("adds one nullable account-scoped timestamp and has a reversible down", () => {
    expect(UP).toContain("alter table user_settings");
    expect(UP).toContain("add column activity_prompt_dismissed_until timestamptz");
    expect(UP).not.toContain("not null");
    expect(DOWN).toContain("drop column if exists activity_prompt_dismissed_until");
  });
});

describe.skipIf(!(HAS_BRANCH && HAS_DB))(`${NAME} against local Docker`, () => {
  it("applies, stores a dismissal, and rolls back through the down migration", async () => {
    const user = await ensureUser("b");
    const sql = [
      "begin;", DOWN,
      "select 'prompt_before:' || count(*) from information_schema.columns",
      " where table_schema='public' and table_name='user_settings'",
      " and column_name='activity_prompt_dismissed_until';",
      UP,
      "select 'prompt_after_up:' || count(*) from information_schema.columns",
      " where table_schema='public' and table_name='user_settings'",
      " and column_name='activity_prompt_dismissed_until';",
      `insert into user_settings (user_id, first_opened_at) values ('${user.id}', now())`,
      " on conflict (user_id) do nothing;",
      `update user_settings set activity_prompt_dismissed_until='2026-10-20T18:00:00Z'`,
      ` where user_id='${user.id}';`,
      "select 'prompt_value:' || activity_prompt_dismissed_until::text from user_settings",
      ` where user_id='${user.id}';`,
      DOWN,
      "select 'prompt_after_down:' || count(*) from information_schema.columns",
      " where table_schema='public' and table_name='user_settings'",
      " and column_name='activity_prompt_dismissed_until';",
      "rollback;",
    ].join("\n");
    const out = runSql(sql);
    expect(out).toContain("prompt_before:0");
    expect(out).toContain("prompt_after_up:1");
    expect(out).toContain("prompt_value:2026-10-20 18:00:00+00");
    expect(out).toContain("prompt_after_down:0");
  });
});
