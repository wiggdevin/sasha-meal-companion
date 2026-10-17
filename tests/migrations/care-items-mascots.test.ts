// W145: 20270105120000 widens care_items.mascots ("can wear") for the seven seeded wearables. The
// SQL lists must be exactly what the phone's own catalog says each companion can wear, so the two
// never drift.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHOP_ITEMS, canWear } from "@/components/today/care/shop/catalog";
import { MASCOT_KEYS } from "@/components/today/island/mascots";

const NAME = "20270105120000_care_items_mascots_widen";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

const rows = new Map(
  [...UP.matchAll(/\('([a-z-]+)', array\[([^\]]+)\]\)/g)]
    .map(([, id, list]) => [id, [...list.matchAll(/'([a-z]+)'/g)].map(([, m]) => m)] as const),
);

describe(`${NAME}.sql`, () => {
  const wearables = SHOP_ITEMS.filter((item) => !item.scene);

  it("lists every wearable with exactly the companions catalog.ts can dress in it", () => {
    expect([...rows.keys()].sort()).toEqual(wearables.map((item) => item.id).sort());
    for (const item of wearables) {
      expect(rows.get(item.id), item.id).toEqual(MASCOT_KEYS.filter((m) => canWear(item, m)));
    }
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
    for (const item of wearables) expect(DOWN).toContain(`'${item.id}'`);
    expect(DOWN).not.toContain("'massage'");
  });
});
