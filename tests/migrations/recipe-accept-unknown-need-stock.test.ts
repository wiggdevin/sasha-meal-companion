// W024 (audit A049): static checks on the migration that stops a shopping accept from storing the
// whole pantry stock for a line whose need is unknown. Both files are replayed against the function
// body as production holds it: the original, then 20261209090300.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const UP = read("supabase/migrations/20261231100000_recipe_accept_unknown_need_stock.sql");
const DOWN = read("supabase/migrations/down/20261231100000_recipe_accept_unknown_need_stock.down.sql");
const ORIGINAL = read("supabase/migrations/20261128090000_recipe_plan_accept.sql");
const KEEPS = read("supabase/migrations/20261209090300_recipe_accept_keeps_selection.sql");

/** The SQL string literals of `name text[] := array[...]` in a migration's declare block. */
function literals(sql: string, name: string): string[] {
  const start = sql.indexOf(`${name} text[] := array[`);
  const end = sql.indexOf("];", start);
  return [...sql.slice(start, end).matchAll(/'((?:[^']|'')*)'/g)]
    .map((match) => match[1].replaceAll("''", "'"));
}
const occurrences = (text: string, part: string) => text.split(part).length - 1;
function patch(body: string, sql: string): string {
  const anchors = literals(sql, "anchors");
  const replacements = literals(sql, "replacements");
  anchors.forEach((anchor, index) => {
    expect(occurrences(body, anchor)).toBe(1);
    body = body.replace(anchor, replacements[index]);
  });
  return body;
}
/** The current production body: the original `$$` body with 20261209090300 applied. */
function currentBody(): string {
  const start = ORIGINAL.indexOf("create function public.recipe_accept_preview(");
  const open = ORIGINAL.indexOf("$$", start) + 2;
  return patch(ORIGINAL.slice(open, ORIGINAL.indexOf("$$;", open)), KEEPS);
}

describe("20261231100000_recipe_accept_unknown_need_stock.sql", () => {
  const anchors = literals(UP, "anchors");
  const replacements = literals(UP, "replacements");

  it("patches the current body at three anchors that each occur exactly once", () => {
    expect(anchors).toHaveLength(3);
    expect(replacements).toHaveLength(3);
    const body = currentBody();
    for (const anchor of anchors) expect(occurrences(body, anchor)).toBe(1);
    expect(body).not.toContain("W024 (audit A049)");
    expect(UP).toContain("if position('W024 (audit A049)' in definition) > 0 then");
    expect(UP).toContain("set local lock_timeout = '3s';");
    expect(UP).toContain("to authenticated;");
  });

  it("writes NULL stock for an unknown need and unchecks a line whose need is unknown", () => {
    const body = patch(currentBody(), UP);
    // No bare least() over the need is left on a line write; the window loop already guarded it.
    expect(body).not.toMatch(/^\s+least\(\(v_expected_line->>'needGrams'\)::numeric,v_stock\),$/m);
    expect(body).not.toContain("confirmed_stock_grams=least(");
    expect(occurrences(body, "case when v_expected_line->>'needGrams' is null then null")).toBe(2);
    expect(body).toContain("checked=case when need_grams is null or v_expected_line->>'needGrams' is null");
    expect(body).toContain("else least(v_window_need,v_stock_remaining) end;");
  });

  it("down restores the previous body byte for byte", () => {
    expect(literals(DOWN, "anchors")).toEqual(anchors);
    expect(literals(DOWN, "replacements")).toEqual(replacements);
    let body = patch(currentBody(), UP);
    replacements.forEach((replacement, index) => {
      expect(occurrences(body, replacement)).toBe(1);
      body = body.replace(replacement, anchors[index]);
    });
    expect(body).toBe(currentBody());
    expect(DOWN).toContain("if position('W024 (audit A049)' in definition) = 0 then return; end if;");
  });
});
