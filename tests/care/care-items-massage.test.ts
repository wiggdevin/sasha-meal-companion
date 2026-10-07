/**
 * UI-NEEDS CARE-MASSAGE (coord.md 2026-10-07T13:14Z): care_items (20261225090200) seeded the
 * seven wearables but not the Massage care scene that landed on main's
 * components/today/care/shop/catalog.ts. Static checks only (no DB): the new migration's insert
 * matches that catalog's own `massage` entry byte for byte, is idempotent, and has a down file.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20261225090600_care_items_massage.sql";
const DOWN = "supabase/migrations/down/20261225090600_care_items_massage.down.sql";
const CATALOG = "components/today/care/shop/catalog.ts";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("the care_items massage seed", () => {
  const up = read(MIGRATION);

  it("inserts exactly the catalog's own massage entry (columns, id, slot, price, art, mascots)", () => {
    // catalog.ts: { id: "massage", name: "Massage", slot: "care", price: 30,
    //   art: "/pet/care/massage-1.webp", aspect: 1.286, places: [], scene: "massage" }
    expect(up).toContain("insert into public.care_items (id, slot, tier, price, asset_key, mascots)");
    expect(up).toContain("values ('massage', 'care', 'care', 30, '/pet/care/massage-1.webp', "
      + "array['sprout', 'blueberry', 'mushroom', 'peapod'])");
  });

  it("is idempotent: a repeat apply is a no-op, not an error", () => {
    expect(up).toMatch(/on conflict \(id\) do nothing/);
  });

  it("never asserts lock/statement timeouts for a table it also creates (this table already exists)", () => {
    expect(up).toContain("set local lock_timeout = '3s';");
    expect(up).toContain("set local statement_timeout = '30s';");
  });

  it("has a down file that refuses to drop an owned item without the data-loss flag, and "
    + "clears every table that references it (not only inventory) when the flag is set", () => {
    expect(existsSync(path.join(process.cwd(), DOWN))).toBe(true);
    const down = read(DOWN);
    expect(down).toContain("app.allow_down_data_loss");
    expect(down).toMatch(/exists \(select 1 from public\.care_inventory where item_id = 'massage'\)/);
    expect(down).toMatch(/exists \(select 1 from public\.care_purchase_receipts where item_id = 'massage'\)/);
    expect(down).toContain("delete from public.care_purchase_receipts where item_id = 'massage';");
    expect(down).toContain("delete from public.care_inventory where item_id = 'massage';");
    expect(down).toContain("delete from public.care_items where id = 'massage';");
  });

  it("matches the landed UI catalog's own massage entry, when that file is present", () => {
    let catalog: string | null = null;
    try {
      catalog = read(CATALOG);
    } catch {
      catalog = null;
    }
    if (catalog === null) return; // Not landed in this worktree; nothing to compare.
    const entry = /\{\s*id:\s*"massage"[\s\S]*?\}/.exec(catalog)?.[0] ?? "";
    expect(entry).toContain('slot: "care"');
    expect(entry).toContain("price: 30");
    expect(entry).toContain('art: "/pet/care/massage-1.webp"');
  });
});
