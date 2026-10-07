// Audit finding S1: static checks on the migration that stops a shopping accept from overwriting
// an accepted recipe selection. Both files are replayed against the original function body.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const UP = read("supabase/migrations/20261209090300_recipe_accept_keeps_selection.sql");
const DOWN = read("supabase/migrations/down/20261209090300_recipe_accept_keeps_selection.down.sql");
const ORIGINAL = read("supabase/migrations/20261128090000_recipe_plan_accept.sql");

/** The body Postgres stores for the function: the text between its `$$` quotes. */
function originalBody(): string {
  const start = ORIGINAL.indexOf("create function public.recipe_accept_preview(");
  const open = ORIGINAL.indexOf("$$", start) + 2;
  return ORIGINAL.slice(open, ORIGINAL.indexOf("$$;", open));
}

/** The SQL string literals of `name text[] := array[...]` in a migration's declare block. */
function literals(sql: string, name: string): string[] {
  const start = sql.indexOf(`${name} text[] := array[`);
  const end = sql.indexOf("];", start);
  return [...sql.slice(start, end).matchAll(/'((?:[^']|'')*)'/g)]
    .map((match) => match[1].replaceAll("''", "'"));
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("20261209090300_recipe_accept_keeps_selection.sql", () => {
  const anchors = literals(UP, "anchors");
  const replacements = literals(UP, "replacements");

  it("patches the current body at two anchors that each occur exactly once", () => {
    expect(anchors).toHaveLength(2);
    expect(replacements).toHaveLength(2);
    const body = originalBody();
    for (const anchor of anchors) expect(occurrences(body, anchor)).toBe(1);
    expect(body).not.toContain("kept selection changed");
    expect(UP).toContain("if position('kept selection changed' in definition) > 0 then");
    expect(UP.match(/does not occur exactly once/g)).toHaveLength(1);
    expect(UP).toContain("to authenticated;");
  });

  it("keeps an accepted selection unchanged and never lets a shopping proof replace one", () => {
    let body = originalBody();
    anchors.forEach((anchor, index) => { body = body.replace(anchor, replacements[index]); });
    const kept = body.indexOf("if v_choice ? 'keptSelectionId' then");
    const baseline = body.indexOf("v_baseline := v_choice->'slotBaseline';");
    const upsert = body.indexOf("insert into public.recipe_plan_selections");
    const guard = body.indexOf("raise exception 'accepted selection changed'");
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(baseline);
    expect(body.slice(kept, baseline)).toContain("continue;");
    expect(body.slice(kept, baseline)).toContain("v_selection.superseded_at is not null");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(upsert);
    expect(body).toContain("(v_preview.kind = 'shopping' or (v_choice ? 'expectedSelectionId'");
  });

  it("down restores the previous body byte for byte", () => {
    expect(literals(DOWN, "anchors")).toEqual(anchors);
    expect(literals(DOWN, "replacements")).toEqual(replacements);
    let body = originalBody();
    anchors.forEach((anchor, index) => { body = body.replace(anchor, replacements[index]); });
    replacements.forEach((replacement, index) => {
      expect(occurrences(body, replacement)).toBe(1);
      body = body.replace(replacement, anchors[index]);
    });
    expect(body).toBe(originalBody());
    expect(DOWN).toContain("if position('kept selection changed' in definition) = 0 then return; end if;");
  });
});
