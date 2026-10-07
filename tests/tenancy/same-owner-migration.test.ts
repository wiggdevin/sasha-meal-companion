/**
 * PR #250 review r1, findings 3 and 6: migration 20261103090100 must refuse to apply over existing
 * cross-account rows, and it must hold its table locks from before the scan until the triggers
 * are installed, so no write can slip in between. The live cases run the migration file on the
 * test database (it is idempotent; the database already carries it).
 */
// Refuses any non-local database before anything else runs (PR #247 review r9).
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, resetUser, runSql, type TestUser } from "../helpers/supabase";

const FILE = "20261103090100_same_owner_references.sql";
const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");

/** Every table whose rows the pre-check reads or whose trigger the migration installs. */
const LOCKED = ["log_items", "favorites_meal_items", "recipe_items", "user_food_prefs",
  "favorites_foods", "favorites_recipes", "duplicate_group_members", "duplicate_groups",
  "media_objects", "coach_messages", "ingest_events", "health_samples", "target_proposals",
  "food_refs", "user_foods", "log_entries", "recipes", "recipe_revisions", "favorites_meals",
  "coach_threads", "ai_calls", "health_sources", "expenditure_estimates"];

describe("the migration locks before it scans", () => {
  it("locks every affected table, scans, and installs the triggers in one DO block", () => {
    const lock = sql.search(/lock table[^;]*in share row exclusive mode'?;/i);
    expect(lock).toBeGreaterThan(-1);
    const statement = sql.slice(lock, sql.indexOf(";", lock));
    for (const t of LOCKED) expect([t, statement.includes(`public.${t}`)]).toEqual([t, true]);
    // One statement from the lock to the last trigger: the Supabase CLI does not wrap a migration
    // file in a transaction block, so only a single DO block keeps the locks through installation.
    const block = sql.lastIndexOf("do $$", lock);
    const scan = sql.indexOf("select string_agg", lock);
    const lastTrigger = sql.lastIndexOf("create trigger");
    expect(block).toBeGreaterThan(-1);
    expect(lock < scan && scan < lastTrigger).toBe(true);
    expect(sql.slice(block, lastTrigger)).not.toContain("end $$");
  });
});

describe.skipIf(!HAS_DB || !HAS_BRANCH)("the migration on a live database", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
  });

  afterAll(async () => {
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
  });

  it("holds the locks until the end of its transaction", () => {
    const names = LOCKED.map((t) => `'${t}'`).join(",");
    const held = runSql(`${sql}
      select count(*) from pg_locks l join pg_class c on c.oid = l.relation
       where l.pid = pg_backend_pid() and l.mode = 'ShareRowExclusiveLock'
         and c.relnamespace = 'public'::regnamespace and c.relname in (${names});`);
    expect(Number(held.split("\n").pop())).toBe(LOCKED.length);
  });

  it("refuses to apply over an existing cross-account row and names the reference", () => {
    const thread = crypto.randomUUID();
    expect(() => runSql(`begin;
      alter table public.coach_messages disable trigger same_owner;
      insert into public.coach_threads (id, user_id) values ('${thread}', '${a.id}');
      insert into public.coach_messages (thread_id, user_id, role, seq)
        values ('${thread}', '${b.id}', 'user', 1);
      alter table public.coach_messages enable trigger same_owner;
      ${sql}
      rollback;`)).toThrow(/same_owner_references: .*coach_messages\.user_id=1/);
    expect(runSql(`select count(*) from public.coach_threads where id = '${thread}'`)).toBe("0");
  });
});
