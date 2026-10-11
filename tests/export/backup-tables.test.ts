/**
 * Audit 2026-10-10 A083: the backup's table list derives from the schema. Every table the
 * migrations leave in place is either backed up or excluded with a reason, and every backed-up
 * table pages by its real primary key. A new migration that creates a table fails this test until
 * the table is classified in lib/server/backup-tables.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, NOT_BACKED_UP } from "@/lib/server/backup-tables";

const DIR = join(process.cwd(), "supabase", "migrations");

type Parsed = { key: string[] | null; userId: boolean };

/** The body between the parenthesis that opens at `start` and its match. */
function balanced(text: string, start: number): string {
  let depth = 1;
  let i = start;
  while (depth > 0 && i < text.length) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    i += 1;
  }
  return text.slice(start, i - 1);
}

function primaryKey(body: string): string[] | null {
  const tableKey = /primary key\s*\(([^)]*)\)/i.exec(body);
  if (tableKey) return tableKey[1].split(",").map((column) => column.trim());
  const columnKey = /^\s*([a-z_0-9]+)\s+[^,\n]*\bprimary key\b/im.exec(body);
  return columnKey ? [columnKey[1]] : null;
}

/** The public tables the migrations create and do not drop, in migration order. */
function schemaTables(): Map<string, Parsed> {
  const tables = new Map<string, Parsed>();
  for (const file of readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(DIR, file), "utf8").replace(/--[^\n]*/g, "");
    const events: { at: number; apply: () => void }[] = [];
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_0-9]+)\s*\(/gi)) {
      const body = balanced(sql, m.index + m[0].length);
      events.push({ at: m.index, apply: () => tables.set(m[1], {
        key: primaryKey(body), userId: /^\s*user_id\b/im.test(body) }) });
    }
    for (const m of sql.matchAll(/drop table (?:if exists )?(?:public\.)?([a-z_0-9]+)/gi)) {
      events.push({ at: m.index, apply: () => tables.delete(m[1]) });
    }
    for (const m of sql.matchAll(/alter table (?:if exists )?(?:public\.)?([a-z_0-9]+)\s+add column (?:if not exists )?user_id\b/gi)) {
      events.push({ at: m.index, apply: () => {
        const known = tables.get(m[1]);
        if (known) tables.set(m[1], { ...known, userId: true });
      } });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  }
  return tables;
}

describe("backup table list (A083)", () => {
  const schema = schemaTables();
  const backedUp = BACKUP_TABLES.map((t) => t.name);

  it("reads the schema it guards", () => {
    expect(schema.size).toBeGreaterThan(80);
    expect(schema.get("user_dietary_profiles")).toEqual({ key: ["user_id", "profile_id"], userId: true });
  });

  it("classifies every table in the schema exactly once", () => {
    const unclassified = [...schema.keys()].filter((name) =>
      !backedUp.includes(name) && !(name in NOT_BACKED_UP));
    expect(unclassified, "add each to BACKUP_TABLES or NOT_BACKED_UP in lib/server/backup-tables.ts")
      .toEqual([]);
    expect(backedUp.filter((name) => name in NOT_BACKED_UP)).toEqual([]);
    expect(new Set(backedUp).size).toBe(backedUp.length);
  });

  it("names only tables that still exist", () => {
    expect([...backedUp, ...Object.keys(NOT_BACKED_UP)].filter((name) => !schema.has(name)))
      .toEqual([]);
  });

  it("gives every exclusion a reason", () => {
    for (const [name, reason] of Object.entries(NOT_BACKED_UP)) {
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });

  it("pages every backed-up table by its complete primary key", () => {
    for (const t of BACKUP_TABLES) expect(t.key, t.name).toEqual(schema.get(t.name)?.key);
  });

  it("backs up the account tables the first list missed", () => {
    for (const name of [
      "user_dietary_profiles", "user_allergen_checks", "food_membership_revisions",
      "shopping_periods", "shopping_lines", "shopping_pantry", "shopping_purchase_windows",
      "recipe_plan_selections", "recipe_plan_state", "recipe_consumed_slot_state",
      "favorites_catalog_recipes", "coach_action_undos", "coach_action_receipts",
      "food_signal_events", "taste_chip_receipts", "taste_dislike_removals",
    ]) expect(backedUp, name).toContain(name);
  });

  it("lists an owner table before the child tables that reference it", () => {
    const at = (name: string) => backedUp.indexOf(name);
    expect(at("log_entries")).toBeLessThan(at("log_items"));
    expect(at("recipes")).toBeLessThan(at("recipe_revisions"));
    expect(at("recipe_revisions")).toBeLessThan(at("recipe_items"));
    expect(at("shopping_periods")).toBeLessThan(at("shopping_lines"));
    expect(at("shopping_lines")).toBeLessThan(at("shopping_purchase_windows"));
    expect(at("coach_threads")).toBeLessThan(at("coach_messages"));
  });
});
