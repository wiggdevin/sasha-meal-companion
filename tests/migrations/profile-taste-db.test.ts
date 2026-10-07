/**
 * Phase 18 W5 (Sol review and re-plan): the database's taste check is a storage contract, and the
 * phone agrees with it in two directions: (a) every taste the phone's write parser accepts, the
 * database accepts; (b) every taste the database accepts survives pull then push unchanged, so no
 * stored key is ever dropped or rewritten. U+0000 and lone surrogates cannot enter jsonb and are
 * tested phone-side (tests/profile/diet-prefs-taste.test.ts). Also: the _sync_upsert patch refuses
 * a partly patched function in both directions.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SENSORY_TAGS } from "@/lib/foods/universe/vocabulary";
import { parseTaste } from "@/lib/profile/taste";
import { settingsProfileFromRow, settingsProfileToRow, type ProfileDietPrefs } from "@/lib/sync/user-settings";
import { HAS_DB, runSql } from "../helpers/supabase";

const COLUMNS = readFileSync("supabase/migrations/20261217090000_profile_cuisines_country.sql", "utf8");
const SYNC_UP = readFileSync("supabase/migrations/20261217090200_profile_sync_cuisines_country.sql", "utf8");
const SYNC_DOWN = readFileSync("supabase/migrations/down/20261217090200_profile_sync_cuisines_country.down.sql", "utf8");
/**
 * UI-NEEDS SPROUT-CARE's mascot migration patches the same `_sync_upsert` user_settings branch
 * these tests probe, layered on top of it in production (every real target carries it). Its own
 * anchors splice text into two of SYNC_UP's five "tos" fragments (the insert column list and the
 * country_code SET clause), so on a database that already carries the mascot patch those two
 * fragments no longer occur verbatim and this describe block's own partial-patch counting would
 * see "3 of 5" instead of "4 of 5" for reasons unrelated to what it is actually testing. Taking
 * the mascot patch off first (each `it` here rolls its own transaction back, so there is nothing
 * to put back) restores the exact function shape these tests were written against.
 */
const MASCOT_DOWN = [
  "down/20261225090010_user_settings_mascot_validate.down.sql",
  "down/20261225090000_user_settings_mascot.down.sql",
].map((f) => readFileSync(`supabase/migrations/${f}`, "utf8")).join("\n");

describe("the taste vocabulary (static)", () => {
  it("the SQL tag list equals SENSORY_TAGS", () => {
    const fn = COLUMNS.slice(COLUMNS.indexOf("create function public.diet_prefs_taste_valid"));
    const list = /in \(([^)]*'t:[^)]*)\)/.exec(fn)?.[1] ?? "";
    const tags = [...list.matchAll(/'t:([a-z_]+)'/g)].map((m) => m[1]);
    expect(tags).toEqual([...SENSORY_TAGS]);
  });
});

const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!HAS_DB)("the database's storage contract and the phone's taste rules", () => {
  const family = (n: number) => `f:${"a".repeat(n)}`;
  const one = (key: string) => ({ dislikes: [key] });
  const CORPUS: unknown[] = [
    {}, { dislikes: [] }, { dislikes: ["f:okra", "t:slimy"] },
    { dislikes: Array.from({ length: 50 }, (_, i) => `f:food ${i}`) },
    { dislikes: Array.from({ length: 51 }, (_, i) => `f:food ${i}`) },
    { dislikes: ["f:okra", "f:okra"] }, { dislikes: ["t:slimy", "t:slimy"] }, one("t:nope"), one("t:"), one("T:slimy"),
    one(family(0)), one(family(1)), one(family(80)), one(family(81)),
    one("f:okra, raw"), one("f:Okra"), one("f:ÉCLAIR"), one("f:green  beans"), one("f:green\tbeans"), one("f: okra"),
    one("f:okra "), one("f:a\u0085b"), one("f:\ufeffokra"), one("f:okra\ufeff"), one("f:a\u00a0b"),
    one("f:👨‍👩‍👧 dinner"), one("f:a\u2028b"), one("f:a\u2029b"), one("f:éclair"), one("f:e\u0301clair"), one("f:eclair"),
    one("f:İstanbul simit"), one("f:i̇"), one("f:豆腐"), one("f:🍣 roll"), one(`f:${"🍣".repeat(80)}`),
    one(`f:${"🍣".repeat(81)}`), one("f:mac & cheese"), one("f:o'brien"), one("okra"), one(7 as unknown as string),
    { dislikes: [null] }, { dislikes: "f:okra" }, { dislikes: [], likes: [] }, { likes: ["f:kale"] }, null, [], "taste",
  ];
  const dbAccepts = (values: unknown[]): boolean[] => {
    const sql = values.map((taste, i) =>
      `select '${i}:' || public.diet_prefs_taste_valid(jsonb_build_object('flags', '[]'::jsonb, 'taste', ${lit(JSON.stringify(taste))}::jsonb));`);
    return runSql(sql.join("\n")).split("\n").map((line) => line.endsWith(":true"));
  };

  it("(a) every taste the phone's write parser accepts, the database accepts", () => {
    const db = dbAccepts(CORPUS);
    const refused = CORPUS.filter((taste, i) => parseTaste(taste) !== null && !db[i]);
    expect(CORPUS.some((taste) => parseTaste(taste) !== null)).toBe(true);
    expect(refused).toEqual([]);
  });

  it("(b) every taste the database accepts survives pull then push unchanged", () => {
    const db = dbAccepts(CORPUS);
    const accepted = CORPUS.filter((_, i) => db[i]);
    expect(accepted.length).toBeGreaterThan(20);
    for (const taste of accepted) {
      const pulled = settingsProfileFromRow({ diet_prefs: { flags: [], taste } as unknown as ProfileDietPrefs });
      expect(settingsProfileToRow(pulled).diet_prefs, JSON.stringify(taste)).toEqual({ flags: [], taste });
    }
  });

  it("the database is a storage contract only: non-canonical families pass, the rest of the shape does not", () => {
    const db = dbAccepts([one("f:Okra"), one("f:a\u0085b"), one("f:\ufeffokra"), one(family(81)), one("t:nope"),
      { dislikes: ["f:okra", "f:okra"] }]);
    expect(db).toEqual([true, true, true, false, false, false]);
  });

  it("accepts a diet_prefs with no taste key, and any non-object diet_prefs is left to the object check", () => {
    expect(runSql("select public.diet_prefs_taste_valid('{\"flags\":[]}'::jsonb)"
      + " and public.diet_prefs_taste_valid(null) and public.diet_prefs_taste_valid('[]'::jsonb);")).toBe("t");
  });
});

describe.skipIf(!HAS_DB)("the _sync_upsert patch refuses a partly patched function", () => {
  // The up file's dollar-quoted parts: five anchors, then their five replacements.
  const parts = [...SYNC_UP.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
  const unpatchDietPrefs = [
    "do $t$ declare d text; begin",
    "  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure) into d;",
    `  d := replace(d, $x$${parts[9]}$x$, $x$${parts[4]}$x$);`,
    "  if position('W5: a diet_prefs object' in d) > 0 then raise exception 'fixture did not unpatch'; end if;",
    "  execute d;",
    "end $t$;",
  ].join("\n");

  it("reads the five anchors and five replacements", () => {
    expect(parts).toHaveLength(10);
    expect(parts[9]).toContain("W5: a diet_prefs object");
  });

  it("up raises on four of five parts", () => {
    expect(() => runSql(["begin;", MASCOT_DOWN, unpatchDietPrefs, SYNC_UP, "rollback;"].join("\n")))
      .toThrow(/4 of 5 parts already patched/);
  });

  it("down raises on four of five parts", () => {
    expect(() => runSql(["begin;", MASCOT_DOWN, unpatchDietPrefs, SYNC_DOWN, "rollback;"].join("\n")))
      .toThrow(/only 4 of 5 parts patched/);
  });

  it("up on the fully patched function is a no-op; down then up restores it byte for byte", () => {
    const def = "select md5(pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure));";
    const out = runSql(["begin;", MASCOT_DOWN, def, SYNC_UP, def, SYNC_DOWN, SYNC_DOWN, SYNC_UP, def, "rollback;"].join("\n"))
      .split("\n").filter((line) => /^[0-9a-f]{32}$/.test(line));
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(1);
  });
});
