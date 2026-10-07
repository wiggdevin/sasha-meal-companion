import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureUser, HAS_BRANCH, HAS_DB, runSql } from "../helpers/supabase";

const NAME = "20261025090200_log_entries_title";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql`, () => {
  it("adds a nullable title capped at 80 characters and wires it through sync", () => {
    expect(UP).toContain("add column title text");
    expect(UP).toContain("char_length(title) <= 80");
    expect(UP).not.toContain("title text not null");
    expect(UP).toContain("p_payload->>'title'");
    expect(UP).toContain("create or replace function _sync_upsert(");
    expect(UP).not.toContain("pg_get_functiondef");
    expect(UP).not.toContain("_sync_upsert_without_log_title");
  });

  it("restores Landing 1's full sync function before dropping the column", () => {
    expect(DOWN.indexOf("create or replace function _sync_upsert("))
      .toBeLessThan(DOWN.indexOf("drop column title"));
    expect(DOWN).not.toContain("pg_get_functiondef");
    expect(DOWN).not.toContain("_sync_upsert_without_log_title");
  });
});

describe.skipIf(!(HAS_BRANCH && HAS_DB))("log entry titles on the local database", () => {
  it("persists title through _sync_upsert and rolls the schema back cleanly", async () => {
    const user = await ensureUser("b");
    const entry = "81511111-1111-4111-8111-111111111111";
    const payload = JSON.stringify({ note: null, media_ref: null,
      eaten_at: "2026-09-20T12:00:00.000Z", tz: "UTC", local_date: "2026-09-20",
      slot: "snack", method: "text", title: "Spaghetti bolognese", items: [] });
    const out = runSql([
      "begin;", DOWN,
      "select 'title_pre:' || count(*) from information_schema.columns",
      "where table_name = 'log_entries' and column_name = 'title';",
      UP,
      `select _sync_upsert('${user.id}', 'log_entries', '${entry}', '${payload}'::jsonb, 1);`,
      `select 'title_value:' || title from log_entries where id = '${entry}';`,
      `select _sync_upsert('${user.id}', 'log_entries', '${entry}',`,
      `'${JSON.stringify({ ...JSON.parse(payload), title: undefined, note: "kept" })}'::jsonb, 2);`,
      `select 'title_kept:' || title from log_entries where id = '${entry}';`,
      `select _sync_upsert('${user.id}', 'log_entries', '${entry}',`,
      `'${JSON.stringify({ ...JSON.parse(payload), title: null, note: "cleared" })}'::jsonb, 3);`,
      `select 'title_cleared:' || coalesce(title, '<null>') from log_entries where id = '${entry}';`,
      DOWN,
      "select 'title_post:' || count(*) from information_schema.columns",
      "where table_name = 'log_entries' and column_name = 'title';",
      "rollback;",
    ].join("\n"));
    expect(out).toContain("title_pre:0");
    expect(out).toContain("title_value:Spaghetti bolognese");
    expect(out).toContain("title_kept:Spaghetti bolognese");
    expect(out).toContain("title_cleared:<null>");
    expect(out).toContain("title_post:0");
  });
});
