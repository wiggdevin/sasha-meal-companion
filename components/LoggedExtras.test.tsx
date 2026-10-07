import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoggedExtraCard, LOST_LINE, STALE_LINE, UNSAVED_LINE } from "./LoggedExtras";
import type { LoggedFood } from "@/lib/types";

const ENTRY: LoggedFood = {
  id: "logged-entry",
  foodId: "food",
  name: "Chicken and rice",
  portionLabel: "plate",
  qty: 1,
  grams: 300,
  macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 },
  at: "2026-09-20T18:00:00.000Z",
};

const SNACK: LoggedFood = {
  id: "entry-1", foodId: "meal", name: "Spaghetti bolognese", slot: "snack",
  portionLabel: "1 item", qty: 1, grams: 350,
  macros: { kcal: 480, protein: 21, carbs: 61.3, fat: 15.8 },
  at: "2026-09-20T20:00:00.000Z",
};

describe("LoggedExtraCard legibility", () => {
  it("keeps every card label free of the ground-only text halo", () => {
    const markup = renderToStaticMarkup(
      <LoggedExtraCard entry={ENTRY} pending={false} onOpen={() => {}} />,
    );
    expect(markup).not.toMatch(/class="[^"]*\bts\b/);
  });
});

describe("LoggedExtraCard", () => {
  it("uses the dish name as the title and the slot as secondary text", () => {
    const markup = renderToStaticMarkup(<LoggedExtraCard entry={SNACK} pending={false}
      onOpen={() => {}} />);
    expect(markup).toContain("Spaghetti bolognese");
    expect(markup).toContain("Snack");
    expect(markup.indexOf("Spaghetti bolognese")).toBeLessThan(markup.indexOf("Snack"));
  });

  it("gives a logged snack its own compact After Dark ticket", () => {
    const snack = renderToStaticMarkup(<LoggedExtraCard entry={SNACK} pending={false}
      onOpen={() => {}} />);
    const ordinary = renderToStaticMarkup(<LoggedExtraCard entry={ENTRY} pending={false}
      onOpen={() => {}} />);
    expect(snack).toContain('data-after-dark-snack="true"');
    expect(ordinary).not.toContain('data-after-dark-snack="true"');
    expect(snack).toContain('data-card-edit="true"');
  });

  it("shows a small food photo matched to each snack ticket's own dish, not a shared one", () => {
    const yogurt = renderToStaticMarkup(<LoggedExtraCard entry={{ ...SNACK, name: "Yogurt and berries" }}
      pending={false} onOpen={() => {}} />);
    const pasta = renderToStaticMarkup(<LoggedExtraCard entry={SNACK} pending={false} onOpen={() => {}} />);
    expect(yogurt).toContain('url=%2Fmeal-art%2Fyogurt.webp');
    expect(yogurt).toContain("Illustrative photo");
    // "Spaghetti bolognese" now matches its own pasta photo (lib/today/meal-art.ts covers nearly
    // every real dish) rather than the yogurt photo above or no photo at all.
    expect(pasta).toContain('url=%2Fmeal-art%2Fpasta.webp');
    expect(pasta).not.toContain('/meal-art/yogurt.webp');
    expect(pasta).toContain("Illustrative photo");
  });
});

/**
 * Design §8.3 — the sync and measurement states the card carries, each one a prop the timeline
 * sets. They are rendered here rather than described, because each is a different line on the
 * card and the walkthrough screenshots them one by one.
 */
describe("LoggedExtraCard's own states", () => {
  const card = (props: Record<string, unknown>, entry: LoggedFood = ENTRY): string =>
    renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}}
      {...props} />);

  it("marks an entry pending with the not-synced dot, and a settled one without it", () => {
    expect(card({ pending: true })).toContain('aria-label="Not synced yet"');
    expect(card({})).not.toContain('aria-label="Not synced yet"');
  });

  it("says a stale entry is still catching up, and only while nothing worse is true", () => {
    expect(card({ stale: true })).toContain(STALE_LINE);
    // Pending outranks stale: one card never carries two sync lines.
    expect(card({ stale: true, pending: true })).not.toContain(STALE_LINE);
  });

  it("offers an unsaved entry its own way to try again", () => {
    const markup = card({ unsaved: true, onRetry: () => {} });
    expect(markup).toContain(UNSAVED_LINE);
  });

  it("tells a lost entry to be logged again rather than leaving it looking saved", () => {
    expect(card({ lost: true })).toContain(LOST_LINE);
    expect(card({})).not.toContain(LOST_LINE);
  });

  it("says kcal pending for an unmeasured entry that carries items, never a zero", () => {
    const withItems: LoggedFood = { ...ENTRY, items: [{ name: "Rice", grams: 200 }] as never };
    const markup = card({ measured: false }, withItems);
    expect(markup).toContain("kcal pending");
    expect(markup).not.toContain("0 kcal");
  });

  it("marks an off-plan entry on the macro line, and leaves a clean one unmarked", () => {
    expect(card({}, { ...ENTRY, flags: ["off-plan"] } as LoggedFood)).toContain("off-plan");
    expect(card({})).not.toContain("off-plan");
  });

  it("says a partly measured recipe serving is at least its kcal, with a partial note (#21)", () => {
    const partial = card({}, { ...ENTRY, nutritionPartial: true });
    expect(partial).toContain("at least ");
    expect(partial).toMatch(/at least <span class="kcal[^"]*">500<\/span> kcal/);
    expect(partial).toContain("data-partial");
    expect(partial).toContain(" · partial");
    // Review (Sol): every figure on the line is a lower bound, so "at least" governs them all: the
    // bounded figures are one group, joined by commas, after the plain amount.
    const text = partial.replace(/<[^>]+>/g, "").replace(/\u00a0/g, " ");
    expect(text).toContain("1 × plate · at least 500 kcal, 40 PRO, 50 CAR, 10 FAT");
    // Never an off-plan mark: partial is a count, not a rule.
    expect(partial).not.toContain("off-plan");
    const whole = card({});
    expect(whole).not.toContain("at least");
    expect(whole).not.toContain("partial");
  });

  it("keeps partial beside off-plan, never in its place", () => {
    const both = card({}, { ...ENTRY, flags: ["off-plan"], nutritionPartial: true });
    expect(both).toContain("off-plan");
    expect(both).toContain(" · partial");
    expect(both.indexOf("off-plan")).toBeLessThan(both.indexOf(" · partial"));
  });

  it("says nothing partial while the kcal is still pending", () => {
    const pendingItems: LoggedFood = { ...ENTRY, nutritionPartial: true,
      items: [{ name: "Stew", grams: 300 }] as never };
    const markup = card({}, pendingItems);
    expect(markup).toContain("kcal pending");
    expect(markup).not.toContain("at least");
    expect(markup).not.toContain("partial");
  });
});

/**
 * t17 gap 2: an item with no known unit weight stores grams null and shows the account's count and
 * unit instead, never the sheet's placeholder 0. Gap 1: a deferred log the server refused shows
 * `notSaved` with its own retry, never the plain unsaved line.
 */
describe("LoggedExtraCard's unknown-mass and not-saved states (t17)", () => {
  const card = (props: Record<string, unknown>, entry: LoggedFood = ENTRY): string =>
    renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}}
      {...props} />);

  it("shows the count and unit for an unknown mass, never 0 g", () => {
    const bowl: LoggedFood = { ...ENTRY, name: "Oatmeal", qty: 1, grams: 0, massUnknown: true,
      portionLabel: "bowl" };
    const markup = card({}, bowl);
    expect(markup).not.toContain("0 g");
    const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("1 × bowl");
  });

  it("marks an unknown mass as partial, the same note a partly measured recipe uses", () => {
    const bowl: LoggedFood = { ...ENTRY, qty: 2, grams: 0, massUnknown: true, portionLabel: "bowl" };
    const markup = card({}, bowl);
    expect(markup).toContain("data-partial");
    expect(markup).toContain(" · partial");
    expect(card({}, ENTRY)).not.toContain("partial");
  });

  it("offers a refused deferred log its own retry, with the reason on the control", () => {
    const refused: LoggedFood = { ...ENTRY, notSaved: "Not saved: the server would not take it. Try again." };
    const markup = card({ onRetry: () => {} }, refused);
    expect(markup).toContain("Not saved. Try again.");
    expect(markup).toContain('title="Not saved: the server would not take it. Try again."');
    expect(card({}, ENTRY)).not.toContain("Not saved. Try again.");
  });

  it("never shows the not-saved retry beside the plain unsaved one", () => {
    const both: LoggedFood = { ...ENTRY, notSaved: "Not saved: try again." };
    const markup = card({ unsaved: true, onRetry: () => {} }, both);
    expect(markup).toContain(UNSAVED_LINE);
    expect(markup).not.toContain("Not saved. Try again.");
  });
});

/**
 * FluidVoice F01-F09: logging states speak the shared feedback language. A save still in flight is
 * yellow (pending), a save that failed is a red error with its own retry, and the retry itself
 * carries the pending state the page's ActionFeedback run hands it.
 */
describe("LoggedExtraCard's feedback roles", () => {
  const card = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(<LoggedExtraCard entry={ENTRY} pending={false} onOpen={() => {}}
      {...props} />);

  it("marks a save in flight with the shared pending state and nothing else", () => {
    expect(card({ pending: true })).toContain('data-feedback-state="pending"');
    expect(card({})).not.toContain("data-feedback-state");
  });

  it("paints an unsaved or lost entry as a red error, never the caution amber", () => {
    const unsaved = card({ unsaved: true, onRetry: () => {} });
    expect(unsaved).toMatch(/<button[^>]*class="[^"]*\btap\b[^"]*\btext-alert\b[^"]*"[^>]*>Not saved yet/);
    expect(card({ lost: true })).toMatch(/text-alert[^"]*">Not saved\. Log it again\./);
  });

  it("puts the page's retry run on the retry control", () => {
    const retrying = card({ unsaved: true, onRetry: () => {}, retryState: "pending" });
    expect(retrying).toMatch(/<button[^>]*data-feedback-state="pending"[^>]*>Not saved yet/);
    expect(retrying).toMatch(/<button[^>]*aria-busy="true"[^>]*>Not saved yet/);
  });
});

/**
 * Design §8.5: a slot value this build does not know must not print a label that claims to be one.
 * "Snack" belongs to the `snack` kind alone; "Logged" said nothing at all. A forward-compatible
 * entry falls back to what it actually is — the foods in it, then its own name.
 */
describe("LoggedExtraCard's secondary label for an unknown slot", () => {
  const unknown = (extra: Partial<LoggedFood>): string =>
    renderToStaticMarkup(<LoggedExtraCard pending={false} onOpen={() => {}}
      entry={{ ...ENTRY, slot: "second-breakfast" as LoggedFood["slot"], ...extra }} />);

  it("never calls an unknown slot a snack", () => {
    expect(unknown({})).not.toContain("Snack");
  });

  it("names the foods in the entry when it has them", () => {
    const markup = unknown({ name: "Meal", items: [
      { id: "i1", seq: 1, food_ref_id: "r1", grams: 120, qty: 1, unit: "portion", snapshot: {},
        foodId: "f1", name: "Chicken", portionLabel: "breast",
        macros: { kcal: 200, protein: 40, carbs: 0, fat: 4 } },
      { id: "i2", seq: 2, food_ref_id: "r2", grams: 180, qty: 1, unit: "portion", snapshot: {},
        foodId: "f2", name: "Rice", portionLabel: "cup",
        macros: { kcal: 250, protein: 5, carbs: 55, fat: 1 } },
    ] });
    expect(markup).toContain("Chicken &amp; Rice");
  });

  it("falls back to the entry's own name when it has no items", () => {
    expect(unknown({ name: "Leftovers" })).toContain("Leftovers");
  });

  it("says 'Logged food' rather than nothing when it has neither", () => {
    expect(unknown({ name: "", items: [] })).toContain("Logged food");
  });

  it("still labels every slot it does know", () => {
    const labelled = (slot: LoggedFood["slot"]) =>
      renderToStaticMarkup(<LoggedExtraCard pending={false} onOpen={() => {}}
        entry={{ ...ENTRY, slot }} />);
    expect(labelled("meal-1")).toContain("Meal 1");
    expect(labelled("meal-2")).toContain("Meal 2");
    expect(labelled("meal-3")).toContain("Meal 3");
    expect(labelled("pouches-pre")).toContain("Pre-training carbs");
    expect(labelled("post-refuel")).toContain("Post-training refuel");
    expect(labelled("hot-chocolate")).toContain("Hot chocolate");
    expect(labelled("coffee")).toContain("Coffee");
    expect(labelled("snack")).toContain("Snack");
  });
});
