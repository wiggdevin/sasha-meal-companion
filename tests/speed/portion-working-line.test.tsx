/**
 * T0 §2 — "after 2 s on any step the sheet shows what it is doing", on the one save that had no
 * such line: logging a catalog food from the portion view. The meal save and every capture already
 * had one (Grok pass 5, LOW).
 *
 * `WorkingLine` renders nothing before its two seconds and `renderToStaticMarkup` never runs an
 * effect, so the line itself can never appear in static markup. The module is stubbed with a
 * marker instead: what is asserted here is that the sheet MOUNTS the line, and mounts it active
 * exactly while the commit is in flight. The delay itself is covered in components/WorkingLine.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LogFoodPortion from "@/components/LogFoodSheet.Portion";
import type { CachedRevision } from "@/lib/db/catalog-cache";

vi.mock("@/components/WorkingLine", () => ({
  default: ({ active, step }: { active: boolean; step: string }) =>
    active ? <p data-working={step}>working</p> : null,
}));

const REVISION = {
  revision_id: 910, catalog_food_id: 41, description: "Chicken breast, roasted", brand: null,
  source: "fdc_sr_legacy", version_label: "2026-04",
  per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 },
  portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
  cached_at: "2026-11-02T17:00:00.000Z",
} as unknown as CachedRevision;

function markup(saving: boolean): string {
  return renderToStaticMarkup(
    <LogFoodPortion
      revision={REVISION}
      portion={null}
      qty={1}
      grams={100}
      gramsText="100"
      mode="food"
      canCommit={!saving}
      saving={saving}
      onPortion={() => {}}
      onQty={() => {}}
      onGramsText={() => {}}
      onConfirm={() => {}}
      onBack={() => {}}
      onClose={() => {}}
    />
  );
}

describe("logging a catalog food", () => {
  it("says what it is doing while the commit is in flight", () => {
    expect(markup(true)).toContain('data-working="commit"');
  });

  it("says nothing at all before she taps Log it", () => {
    expect(markup(false)).not.toContain("data-working");
  });
});
