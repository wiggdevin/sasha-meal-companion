import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBlock } from "@/components/coach/blocks";
import { proposeDraftSchema, uiBlockV1Schema, uiBlockSchema } from "@/lib/coach/ui-blocks";
import { captureProposal } from "@/tests/coach/editors/fixtures";

/** Generative UI (design system slice 3, 2026-09-22): the coach emits a small tree of typed nodes
 *  and the primitives draw it. Never raw HTML, a colour, a class or a style. */
const TREE = {
  kind: "ui", v: 1, id: "ui-1",
  root: {
    type: "card", title: "Lunch adjustment", children: [
      { type: "text", variant: "body", text: "Swap the rice for quinoa and you land on target." },
      { type: "metric_row", items: [
        { label: "Calories", value: "450 kcal", delta: "-120" },
        { label: "Protein", value: "42 g", delta: "+10" },
      ] },
      { type: "food_item", name: "Grilled chicken salad", detail: "200 g breast, greens, 10 ml olive oil", grams: 320 },
      { type: "list", rows: [{ title: "Quinoa, cooked", meta: "120 kcal", trailing: "100 g" }] },
      { type: "button_group", actions: [
        { id: "apply", label: "Update Meal 2", variant: "primary" },
        { id: "keep", label: "Keep current", variant: "quiet" },
      ] },
    ],
  },
};

const ctx = {
  isLatestAssistant: true, sendText: vi.fn(), commitLogDraft: vi.fn(), openFood: vi.fn(),
} as never;

describe("the ui block schema", () => {
  it("keeps an alternative's exact revision through Coach draft validation", () => {
    const proposal = { ...captureProposal, items: [{ ...captureProposal.items[0],
      alternatives: [{ foodRefId: "ref-banana", catalogFoodRevisionId: 70,
        label: "Banana, raw", score: 0.9 }],
    }] };
    expect(proposeDraftSchema.parse(proposal).items[0].alternatives[0])
      .toMatchObject({ foodRefId: "ref-banana", catalogFoodRevisionId: 70 });
  });

  it("accepts a card tree of the six node types", () => {
    expect(uiBlockV1Schema.safeParse(TREE).success).toBe(true);
    expect(uiBlockSchema.safeParse(TREE).success).toBe(true);
  });

  it("rejects an unknown node type, and any style, class or colour", () => {
    const unknown = { ...TREE, root: { type: "iframe", src: "x" } };
    expect(uiBlockV1Schema.safeParse(unknown).success).toBe(false);
    const styled = { ...TREE, root: { ...TREE.root, style: { color: "red" } } };
    expect(uiBlockV1Schema.safeParse(styled).success).toBe(false);
    const classed = { ...TREE, root: { ...TREE.root, className: "bg-red-500" } };
    expect(uiBlockV1Schema.safeParse(classed).success).toBe(false);
  });

  it("rejects a tree deeper than three cards", () => {
    const deep = { ...TREE, root: { type: "card", children: [{ type: "card", children: [
      { type: "card", children: [{ type: "card", children: [] }] }] }] } };
    expect(uiBlockV1Schema.safeParse(deep).success).toBe(false);
  });

  it("rejects a button variant outside the primitive's set", () => {
    const bad = { ...TREE, root: { type: "button_group", actions: [{ id: "a", label: "x", variant: "danger" }] } };
    expect(uiBlockV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("the ui block renderer", () => {
  it("draws the tree with the primitives and sends a button's label as the reply", () => {
    const element = renderBlock(TREE, ctx);
    expect(element).not.toBeNull();
    const markup = renderToStaticMarkup(element!);
    expect(markup).toContain("Lunch adjustment");
    expect(markup).toContain('class="shell');
    expect(markup).toContain('<span class="kcal font-semibold tabular-nums">450</span> kcal');
    expect(markup).toContain("Grilled chicken salad");
    expect(markup).toContain("list-row");
    expect(markup).toContain("btn-primary");
    expect(markup).toContain("Keep current");
  });
});
