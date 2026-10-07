/**
 * 2026-10-04 re-audit r1 (server slice) on the document and menu reads:
 * - every field the server sends fits the phone's documentResultSchema caps, so a successful read
 *   is never refused on the phone (#5): long dish names and tips from the model, long allergen
 *   labels in the menu "check" line;
 * - a menu dish on an account with Avoid marks is never shown with no check (#6);
 * - a portion label written as a mixed number counts as one (#7).
 * No I/O.
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { documentResultSchema, MAX_MENU_CHECK } from "@/lib/plan/document-types";
import { labelQuantity } from "@/lib/plan/document-ground";
import { cleanMenu } from "@/lib/plan/photo-result";
import { askAbout, menuVerdict, screenMenu } from "@/lib/server/plan-menu";

const dish = { name: "Grilled chicken bowl", kcal: 600, protein: 40, carbs: 60, fat: 20, tip: null,
  check: null, ingredients: ["chicken", "rice"] };

describe("menu check line", () => {
  it("stays within the phone's cap with long allergen labels", () => {
    const long = ["tree nuts including almonds, cashews, walnuts, pecans and pistachios",
      "crustacean shellfish such as shrimp, crab and lobster and anything cooked with them",
      "sesame seeds, tahini and sesame oil"];
    const check = askAbout(long);
    expect(check.length).toBeLessThanOrEqual(MAX_MENU_CHECK);
    expect(check.startsWith("Ask about tree nuts")).toBe(true);
    expect(askAbout(["x".repeat(400)]).length).toBeLessThanOrEqual(MAX_MENU_CHECK);
    expect(askAbout(["peanuts", "sesame"])).toBe("Ask about peanuts, sesame");
  });

  it("never presents a partial allergen list as complete (2026-10-05 audit, MAJOR 5)", () => {
    // The first label alone (142 chars) fits with room for the marker; adding ", peanuts" would
    // push the full line past the cap, and it must not be silently dropped with no sign of a cut.
    const firstLabel = "tree nuts including almonds cashews walnuts pecans and pistachios found in "
      + "nearly every sauce served here tonight for sure and also in many of";
    const check = askAbout([firstLabel, "peanuts"]);
    expect(check.length).toBeLessThanOrEqual(MAX_MENU_CHECK);
    expect(check).toContain("tree nuts");
    expect(check.endsWith("and others")).toBe(true);
    expect(check).not.toContain("peanuts");

    // Three labels that together overflow the cap: the kept ones never look like the full list.
    const three = ["tree nuts including almonds, cashews, walnuts, pecans and pistachios",
      "crustacean shellfish such as shrimp, crab and lobster and anything cooked with them",
      "sesame seeds, tahini and sesame oil"];
    const multi = askAbout(three);
    expect(multi.length).toBeLessThanOrEqual(MAX_MENU_CHECK);
    expect(multi.endsWith("and others")).toBe(true);
    expect(multi).not.toContain("sesame");

    // Every label fits: no marker is added, because nothing was left out.
    expect(askAbout(["peanuts", "sesame"]).endsWith("and others")).toBe(false);
  });

  // 2026-10-05 audit, MINOR 7 (false positive): the claim was that `{ kind: "other" }` — the
  // DocumentResult for "nothing usable" — fails documentResultSchema and turns into a retryable
  // 502. The schema already carries a `z.object({ kind: z.literal("other") })` branch (added in
  // ceb6a55, itself inside the audited range), so this parses as success, not a 502. Locked here
  // so the route's "other" state can never regress into a false retry.
  it("parses a nothing-usable read as success, not a schema failure", () => {
    const parsed = documentResultSchema.safeParse({ kind: "other" });
    expect(parsed.success).toBe(true);
  });

  it("tells an account with Avoid marks to check a dish the search did not flag", () => {
    expect(menuVerdict(EMPTY_PROFILE, dish).check).toBeNull();
    expect(menuVerdict({ ...EMPTY_PROFILE, avoid_food_ref_ids: ["ref-1"] }, dish).check)
      .toBe("Check it against your Avoid list");
  });
});

describe("a menu read the phone accepts", () => {
  it("passes documentResultSchema with model-length names and tips and long allergen labels", async () => {
    const raw = [
      { name: "Slow roasted heritage pork shoulder with charred spring onion and apple slaw on the side",
        kcal: 640, protein: 42, carbs: 40, fat: 30,
        tip: "Ask for the slaw dressing on the side and swap the fries for a green salad if they can do that tonight" },
      { name: "Chicken salad", kcal: 520, protein: 38, carbs: 20, fat: 24, tip: "Dressing on the side" },
    ];
    const profile = { ...EMPTY_PROFILE, avoid_allergens: ["a".repeat(90), "b".repeat(90), "c".repeat(90)] };
    const menu = await screenMenu("u1", cleanMenu(raw), 600, profile, vi.fn(async () => []));
    expect(menu.length).toBeGreaterThan(0);
    const body = { kind: "menu", title: null, ingredients: [], menu };
    expect(documentResultSchema.safeParse(body).success).toBe(true);
  });
});

describe("portion label quantity", () => {
  it("reads mixed numbers and vulgar fractions", () => {
    expect(labelQuantity("1 1/2 cups", true)).toBe(1.5);
    expect(labelQuantity("1½ cup", true)).toBe(1.5);
    expect(labelQuantity("½ cup", true)).toBe(0.5);
    expect(labelQuantity("1/2 cup", true)).toBe(0.5);
    expect(labelQuantity("2 slices", false)).toBe(2);
    expect(labelQuantity("100 g", false)).toBe(1);
    expect(labelQuantity("250 ml", false)).toBe(1);
    expect(labelQuantity("medium", false)).toBe(1);
  });
});
