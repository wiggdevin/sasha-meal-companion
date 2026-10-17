import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase/migrations");
const up = readFileSync(join(dir, "20270105130000_function_search_path.sql"), "utf8");
const down = readFileSync(join(dir, "down/20270105130000_function_search_path.down.sql"), "utf8");

const FUNCTIONS = [
  "_sync_assert_key(text, text)",
  "catalog_search_doc(text, text, text)",
  "compute_item_snapshot(uuid, numeric)",
];

describe("W122 function search_path", () => {
  it("pins public, pg_temp on each flagged function and resets it on the way down", () => {
    for (const fn of FUNCTIONS) {
      expect(up).toContain(`alter function public.${fn} set search_path = public, pg_temp;`);
      expect(down).toContain(`alter function public.${fn} reset search_path;`);
    }
  });
});
