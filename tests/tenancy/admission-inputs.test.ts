/**
 * Phase 18 W2b re-plan: every table admission reads (lib/foods/world/admission-inputs.ts) has
 * insert, update and delete clock triggers, so any write to it moves an admission-input version.
 * The static half reads the migration files and runs in every unit shard; the database half reads
 * pg_trigger on the migrated local stack (CI Integration job).
 */
import "./local-only";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ADMISSION_INPUTS, CLOCK_FUNCTIONS, SHARED_ADMISSION_INPUTS,
} from "@/lib/foods/world/admission-inputs";
import { HAS_DB, runSql } from "../helpers/supabase";

const DIR = path.join(process.cwd(), "supabase/migrations");
const TRIGGER = /create\s+trigger\s+\w+\s+(?:before|after)\s+([\s\S]+?)\s+on\s+public\.(\w+)[\s\S]*?execute\s+function\s+public\.(\w+)\(\)/gi;
const EVENTS = ["insert", "update", "delete"] as const;

/** `${table}:${function}` → the events the migrations attach it to. */
function declaredTriggers(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort()) {
    for (const [, events, table, fn] of readFileSync(path.join(DIR, file), "utf8").matchAll(TRIGGER)) {
      const key = `${table}:${fn}`;
      const set = out.get(key) ?? new Set<string>();
      for (const event of EVENTS) if (new RegExp(`\\b${event}\\b`, "i").test(events)) set.add(event);
      out.set(key, set);
    }
  }
  return out;
}

const expected = [
  ...ACCOUNT_ADMISSION_INPUTS.map((table) => [table, CLOCK_FUNCTIONS.account] as const),
  ...SHARED_ADMISSION_INPUTS.map((table) => [table, CLOCK_FUNCTIONS.shared] as const),
];

describe("admission-input clock triggers", () => {
  it("the inventory names each table once", () => {
    const all = [...ACCOUNT_ADMISSION_INPUTS, ...SHARED_ADMISSION_INPUTS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("the migrations give every inventory table insert, update and delete clock triggers", () => {
    const declared = declaredTriggers();
    const missing = expected.flatMap(([table, fn]) => EVENTS
      .filter((event) => !declared.get(`${table}:${fn}`)?.has(event)).map((event) => `${table} ${event} ${fn}`));
    expect(missing).toEqual([]);
  });

  it.skipIf(!HAS_DB)("the migrated database has them, enabled", () => {
    // tgtype bits: 4 insert, 8 delete, 16 update.
    const rows = runSql(`select relname || ':' || proname || ':' || bits from (
        select c.relname, p.proname, bit_or(t.tgtype::int & 28) as bits
          from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where not t.tgisinternal and t.tgenabled = 'O' and p.proname in ('rules_clock_bump', 'evidence_clock_bump')
         group by c.relname, p.proname) x`).split("\n").filter(Boolean);
    const found = new Map(rows.map((row) => {
      const [table, fn, bits] = row.split(":");
      return [`${table}:${fn}`, Number(bits)];
    }));
    expect(expected.filter(([table, fn]) => found.get(`${table}:${fn}`) !== 28).map(([table]) => table)).toEqual([]);
  });
});
