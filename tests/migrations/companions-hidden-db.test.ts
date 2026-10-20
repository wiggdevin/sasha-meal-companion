/**
 * UI makeover W3 (docs/plans/2026-10-19-ui-makeover.md §5): `user_settings.companions_hidden`, the
 * companions an account hid from Today. Static checks run in every unit shard; the database half
 * runs the sync RPC and steps the two files down and up inside one transaction on the local stack and
 * rolls it back. Production is applied by the owner, with a backup, before the W3 code merges.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsProfileFromRow, settingsProfileToRow } from "@/lib/sync/user-settings";
import { HAS_DB, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) => t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const NAMES = ["20270107090000_user_settings_companions_hidden", "20270107090100_user_settings_companions_hidden_validate"];
const up = (name: string) => read(`supabase/migrations/${name}.sql`);
const down = (name: string) => read(`supabase/migrations/down/${name}.down.sql`);
const DEF = "pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)";

describe("companions_hidden migrations (static)", () => {
  it("are live-safe: lock and statement timeouts, a constant default, the check NOT VALID then validated", () => {
    for (const name of NAMES) expect(up(name)).toContain("set local lock_timeout = '3s';");
    const columns = sqlOnly(up(NAMES[0]));
    expect(columns).toContain("add column companions_hidden text[] not null default '{}';");
    expect(columns).toMatch(/check \(public\.companions_hidden_valid\(companions_hidden\)\) not valid;/);
    expect(columns).not.toMatch(/\bvalidate constraint\b|\bupdate public\.user_settings\b/);
    expect(sqlOnly(up(NAMES[1]))).toContain("validate constraint user_settings_companions_hidden_check;");
  });

  it("keeps the _sync_upsert grant at service_role only", () => {
    const sync = sqlOnly(up(NAMES[0]));
    expect(sync).toContain("revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)\n  from public, anon, authenticated;");
    expect(sync).not.toMatch(/grant execute[^;]*_sync_upsert[^;]*(authenticated|anon)/);
  });

  it("has a down file for each, and the column down refuses to forget a hidden companion", () => {
    for (const name of NAMES) expect(down(name).length).toBeGreaterThan(0);
    expect(down(NAMES[0])).toContain("app.allow_down_data_loss");
  });
});

describe("the phone's side of the column", () => {
  it("keeps a key this phone does not know, drops repeats on read, and reads an older row as nothing hidden", () => {
    expect(settingsProfileFromRow({ companions_hidden: ["blueberry", "dragon", "blueberry", "sprout"] }).companionsHidden)
      .toEqual(["blueberry", "dragon", "sprout"]);
    expect(settingsProfileFromRow({}).companionsHidden).toBeUndefined();
  });

  it("never sends the list from a whole-profile save: a stale copy would undo another phone's choice", () => {
    expect(settingsProfileToRow({} as never)).not.toHaveProperty("companions_hidden");
    expect(settingsProfileToRow({ companionsHidden: [] } as never)).not.toHaveProperty("companions_hidden");
    expect(settingsProfileToRow({ companionsHidden: ["peapod"] } as never)).not.toHaveProperty("companions_hidden");
  });

  it("keeps a key as the database counts it: 40 characters, not 40 UTF-16 units", () => {
    const wide = "🌱".repeat(21);
    const long = "🌱".repeat(41);
    expect(settingsProfileFromRow({ companions_hidden: [wide, long] }).companionsHidden).toEqual([wide]);
  });
});

describe.skipIf(!HAS_DB)("companions_hidden on the database (rolled back)", () => {
  const owner = "00000000-0000-4000-8000-0000000c0a01";
  const seed = [
    "begin;",
    `insert into auth.users (id, email) values ('${owner}', 'w3-companions@meal-companion.test');`,
  ];
  const sync = (payload: unknown, rev: number) =>
    `select _sync_upsert('${owner}', 'user_settings', 'settings', '${JSON.stringify(payload)}'::jsonb, ${rev});`;
  const stored = (label: string) =>
    `select '${label}:' || array_to_string(companions_hidden, ',') from public.user_settings where user_id = '${owner}';`;
  const refused = (label: string, sql: string) => [
    "do $t$ begin",
    `  ${sql}`,
    `  raise notice 'unexpected';`,
    `exception when others then perform set_config('test.${label}', sqlerrm, true);`,
    "end $t$;",
    `select '${label}:' || current_setting('test.${label}', true);`,
  ].join("\n");

  it("syncs with the cuisines rule: omitted keeps, [] clears, null and bad lists are refused", () => {
    const out = runSql([...seed,
      sync({ meals_per_day: 3 }, 1), stored("insert_default"),
      sync({ companions_hidden: ["sprout", "blueberry"] }, 2), stored("set"),
      sync({ meals_per_day: 4 }, 3), stored("omitted_keeps"),
      refused("null", sync({ companions_hidden: null }, 4).replace(/^select /, "perform ")),
      refused("ninth", sync({ companions_hidden: Array.from({ length: 9 }, (_, i) => `k${i}`) }, 4).replace(/^select /, "perform ")),
      refused("long", sync({ companions_hidden: ["x".repeat(41)] }, 4).replace(/^select /, "perform ")),
      refused("empty", sync({ companions_hidden: [""] }, 4).replace(/^select /, "perform ")),
      stored("after_refusals"),
      sync({ companions_hidden: [] }, 4), stored("cleared"),
      "rollback;",
    ].join("\n")).split("\n");
    expect(out).toContain("insert_default:");
    expect(out).toContain("set:sprout,blueberry");
    expect(out).toContain("omitted_keeps:sprout,blueberry");
    expect(out.find((l) => l.startsWith("null:"))).toMatch(/companions_hidden_null/);
    for (const label of ["ninth", "long", "empty"]) {
      expect(out.find((l) => l.startsWith(`${label}:`))).toMatch(/user_settings_companions_hidden_check/);
    }
    expect(out).toContain("after_refusals:sprout,blueberry");
    expect(out).toContain("cleared:");
  });

  it("the column down refuses while an account has hidden a companion", () => {
    expect(() => runSql([...seed,
      `insert into public.user_settings (user_id, first_opened_at, companions_hidden) values ('${owner}', now(), '{sprout}');`,
      down(NAMES[1]), down(NAMES[0]), "rollback;"].join("\n")))
      .toThrow(/accounts have hidden a companion/);
  });

  it("steps down and up again; the sync patch comes back byte for byte and a second up is a no-op", () => {
    const out = runSql([...seed,
      "set local app.allow_down_data_loss = 'on';",
      `select set_config('test.pre_def', ${DEF}::text, true);`,
      down(NAMES[1]), down(NAMES[0]),
      "select 'dropped:' || not exists (select 1 from information_schema.columns where table_name = 'user_settings'"
        + " and column_name = 'companions_hidden');",
      `select 'sync_clean:' || (position('companions_hidden' in ${DEF}) = 0);`,
      `select 'mascot_kept:' || (position('mascot = coalesce' in ${DEF}) > 0);`,
      up(NAMES[0]), up(NAMES[1]),
      `select 'roundtrip:' || (${DEF}::text = current_setting('test.pre_def'));`,
      // The column exists now, so a re-run of the whole file is refused by its guard; the sync patch
      // on its own (the second DO block) is the part that must be idempotent.
      up(NAMES[0]).slice(up(NAMES[0]).indexOf("do $migration$")),
      `select 'idempotent:' || (${DEF}::text = current_setting('test.pre_def'));`,
      "rollback;",
    ].join("\n")).split("\n");
    expect(out.filter((l) => /^[a-z_]+:(true|false)$/.test(l)))
      .toEqual(["dropped:true", "sync_clean:true", "mascot_kept:true", "roundtrip:true", "idempotent:true"]);
  });
});
