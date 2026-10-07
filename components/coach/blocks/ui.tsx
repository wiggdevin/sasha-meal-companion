"use client";

import type { CoachBlockContext } from "@/components/coach/blocks/context";
import type { UiBlockV1, UiNode } from "@/lib/coach/ui-blocks";
import { Button, ListRow, Surface } from "@/components/ui";
import KcalText from "@/components/ui/KcalText";

const TEXT: Record<"body" | "caption" | "eyebrow", string> = {
  body: "m-0 text-body-md text-charcoal",
  caption: "m-0 text-caption text-muted",
  eyebrow: "m-0 text-eyebrow font-semibold uppercase tracking-eyebrow text-muted",
};

/**
 * Draws one generative-UI node with the primitives (lib/coach/ui-blocks uiNodeSchema). A button
 * sends its label back as the reply: the coach then acts through its normal, grounded actions,
 * so a card can never apply anything on its own.
 */
function Node({ node, ctx }: { node: UiNode; ctx: CoachBlockContext }) {
  switch (node.type) {
    case "card":
      return (
        <Surface className="flex flex-col gap-3 px-4 py-4">
          {node.title && <h3 className="section-title m-0 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm">{node.title}</h3>}
          {node.children.map((child, i) => <Node key={i} node={child as UiNode} ctx={ctx} />)}
        </Surface>
      );
    case "text":
      return <p className={TEXT[node.variant]}>{node.text}</p>;
    case "metric_row":
      return (
        <dl className="m-0 grid gap-2" style={{ gridTemplateColumns: `repeat(${node.items.length}, minmax(0, 1fr))` }}>
          {node.items.map((item) => (
            <div key={item.label} className="flex min-w-0 flex-col">
              <dt className="text-tiny text-muted">{item.label}</dt>
              <dd className="m-0 text-body-md font-medium tabular-nums text-charcoal">
                <KcalText text={item.value} />{item.delta && <span className="ml-1 text-tiny text-muted">{item.delta}</span>}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "food_item":
      return <ListRow title={node.name} meta={node.detail} trailing={node.grams ? `${node.grams} g` : undefined} />;
    case "list":
      return (
        <div className="flex flex-col">
          {node.rows.map((row, i) => <ListRow key={i} title={row.title} meta={row.meta} trailing={row.trailing} />)}
        </div>
      );
    case "button_group":
      return (
        <div className="flex flex-col gap-2">
          {node.actions.map((action) => (
            <Button key={action.id} variant={action.variant} onClick={() => ctx.sendText(action.label)}>
              {action.label}
            </Button>
          ))}
        </div>
      );
  }
}

export default function UiBlock({ block, ctx }: { block: UiBlockV1; ctx: CoachBlockContext }) {
  return <Node node={block.root} ctx={ctx} />;
}
