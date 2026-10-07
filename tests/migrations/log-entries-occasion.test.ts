// Phase 17 O2, D1: log_entries.occasion / occasion_source. Static checks on the SQL text, the same
// pattern as the other additive-column migrations; the move trigger is internal like the body-fat
// provenance trigger (revoked from every client role, so the RPC manifest need not list it).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NAME = "20261210090200_log_entries_occasion";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read(`supabase/migrations/${NAME}.sql`);
const DOWN = read(`supabase/migrations/down/${NAME}.down.sql`);
const sqlOnly = (text: string) => text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

describe(`${NAME}.sql`, () => {
  it("adds two nullable columns with closed value sets, set together or not at all", () => {
    expect(UP).toContain("add column if not exists occasion text");
    expect(UP).toContain("check (occasion in ('breakfast', 'lunch', 'dinner', 'snack', 'other'))");
    expect(UP).toContain("add column if not exists occasion_source text");
    expect(UP).toContain("check (occasion_source in ('slot_clock', 'override', 'user'))");
    expect(UP).toContain("check ((occasion is null) = (occasion_source is null))");
    expect(sqlOnly(UP)).not.toMatch(/occasion(_source)? text[^,;]*not null/i);
    // Old rows stay null: no backfill.
    expect(sqlOnly(UP)).not.toMatch(/update\s+log_entries/i);
  });

  it("clears the stamp when an edit moves the entry to another slot, day, time or zone", () => {
    expect(UP).toContain("before update of slot, local_date, eaten_at, tz on log_entries");
    expect(UP).toContain("new.slot is distinct from old.slot or new.local_date is distinct from old.local_date");
    expect(UP).toContain("or new.eaten_at is distinct from old.eaten_at or new.tz is distinct from old.tz");
    // Kept only when the same write sets the user's own choice; otherwise both columns clear.
    expect(UP).toContain("and not (new.occasion_source = 'user' and new.occasion is not null");
    expect(UP).toContain("new.occasion := null;");
    expect(UP).toContain("new.occasion_source := null;");
  });

  it("keeps the trigger function away from every client role", () => {
    expect(UP).toContain("revoke all on function public.log_entries_occasion_on_move() from public, anon, authenticated;");
    expect(sqlOnly(UP)).not.toMatch(/security definer/i);
    expect(sqlOnly(DOWN)).not.toMatch(/grant[^;]*(authenticated|anon|public)/i);
  });

  it("down removes exactly what up added", () => {
    expect(DOWN).toContain("drop index if exists log_entries_occasion_window;");
    expect(DOWN).toContain("drop trigger if exists log_entries_occasion_on_move on log_entries;");
    expect(DOWN).toContain("drop function if exists public.log_entries_occasion_on_move();");
    expect(DOWN).toContain("drop column if exists occasion_source, drop column if exists occasion;");
  });
});
