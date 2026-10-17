// W145: 20270105120000 widens care_items.mascots ("can wear") for the seven seeded wearables. The
// expected lists are frozen here as catalog.ts's `canWear` stood on 2026-10-17, so a later catalog
// change never asks anyone to edit an applied migration; a later widening is its own migration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NAME = "20270105120000_care_items_mascots_widen";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

const rows = new Map(
  [...UP.matchAll(/\('([a-z-]+)', array\[([^\]]+)\]\)/g)]
    .map(([, id, list]) => [id, [...list.matchAll(/'([a-z]+)'/g)].map(([, m]) => m)] as const),
);

const ALL = ["sprout", "blueberry", "mushroom", "peapod"];
const NO_POD = ["sprout", "blueberry", "mushroom"];
const EXPECTED: Record<string, string[]> = {
  "leaf-pin": ALL, mittens: ALL, "bucket-hat": NO_POD, "knitted-hat": NO_POD,
  glasses: ALL, sunglasses: ALL, shorts: ALL,
};

describe(`${NAME}.sql`, () => {
  it("lists every seeded wearable with the companions that could wear it on 2026-10-17", () => {
    expect(Object.fromEntries(rows)).toEqual(EXPECTED);
  });

  it("keeps Pod out of both hats", () => {
    expect(rows.get("bucket-hat")).not.toContain("peapod");
    expect(rows.get("knitted-hat")).not.toContain("peapod");
  });

  it("only widens, and skips a row that already lists them all", () => {
    expect(UP).toContain("where m <> all(c.mascots)");
    expect(UP).toContain("not (c.mascots @> w.wearers)");
    expect(UP).not.toMatch(/\bdelete\b|\balter\b|\bdrop\b/i);
  });

  it("down puts the same seven back to Sprout only and leaves Massage alone", () => {
    expect(DOWN).toContain("set mascots = array['sprout']");
    for (const id of Object.keys(EXPECTED)) expect(DOWN).toContain(`'${id}'`);
    expect(DOWN).not.toContain("'massage'");
  });
});
