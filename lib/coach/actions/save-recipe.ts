/** `save_recipe`: save a meal as a recipe the user can log again; Undo deletes it. */

import { z } from "zod";
import {
  actionItem, groundedActionItemSchema, groundedBaseSchema,
  type GroundedActionItem, type GroundedBase,
} from "@/lib/coach/actions/fields";
import { itemLine } from "@/lib/coach/actions/copy";
import { act, clarify, flagged, groundItems } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({
  kind: z.literal("save_recipe"), name: z.string().min(1).max(80),
  items: z.array(actionItem).min(1).max(12),
});

export const saveRecipe: ActionSpec<{
  kind: "save_recipe";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "save_recipe"; name: string; items: GroundedActionItem[];
    refusals?: string[] };
  token: { kind: "save_recipe"; recipeId: string; rev: number };
}> = {
  kind: "save_recipe",
  input,
  wire: { named: ["name", "items"] },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("save_recipe"),
    name: z.string().min(1).max(80),
    items: z.array(groundedActionItemSchema).min(1).max(12),
    refusals: z.array(z.string().min(1).max(240)).max(12).optional() }),
  ground: async (value, kit) => {
    const grounded = await groundItems(kit, value.items);
    if ("missing" in grounded) return clarify(...grounded.missing);
    const { items } = grounded;
    return act((actionId) => ({ ...value, actionId, flagged: flagged(items), items }));
  },
  history: (action) => ` "${action.name}" → ${action.items.map(itemLine).join(", ")}`,
  prompt: { rank: 110, lines: [
    "  save_recipe { name, items } — save a meal you can log again.",
  ] },
  card: {
    title: (action) => `Saved the recipe "${action.name}"`,
    lines: (action) => action.items,
    macroItems: (action) => action.items,
  },
};
