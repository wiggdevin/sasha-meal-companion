// TDEE step E6: static checks on the day-mark migration. The real-database round trip is
// tests/sync/day-complete-db.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const UP = readFileSync(path.join(root,
  "supabase/migrations/20261209090100_plan_days_day_complete.sql"), "utf8");
const DOWN = readFileSync(path.join(root,
  "supabase/migrations/down/20261209090100_plan_days_day_complete.down.sql"), "utf8");

describe("20261209090100_plan_days_day_complete.sql", () => {
  it("adds a nullable mark and a server-owned first-mark date, with no backfill", () => {
    expect(UP).toContain("alter table public.plan_days add column day_complete_at timestamptz;");
    expect(UP).toContain("alter table public.user_settings add column day_marks_started_on date;");
    expect(UP).not.toMatch(/update public\.plan_days/i);
  });

  it("syncs the mark with the omit/keep rule and keeps _sync_upsert service-role only", () => {
    expect(UP).toContain("case when p_payload ? ''day_complete_at''");
    expect(UP).toContain("else plan_days.day_complete_at end,");
    expect(UP.match(/does not occur exactly once/g)).toHaveLength(1);
    expect(UP).toContain("from public, anon, authenticated;");
  });

  it("only ever moves the first-mark date earlier", () => {
    expect(UP).toContain("day_marks_started_on is null or day_marks_started_on > new.local_date");
    expect(UP).toContain("if new.day_complete_at is not null then");
    expect(UP).toContain("revoke all on function public.plan_days_record_first_mark()");
  });

  it("down refuses to drop marks without consent and drops the trigger before the columns", () => {
    expect(DOWN).toContain("app.allow_down_data_loss");
    const order = ["drop trigger if exists plan_days_record_first_mark",
      "drop column day_marks_started_on", "drop column day_complete_at"]
      .map((statement) => DOWN.indexOf(statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
