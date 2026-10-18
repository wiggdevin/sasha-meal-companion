"use client";

import { useState } from "react";
import type { CoachBlockContext } from "@/components/coach/blocks/context";
import type { NextActionChipBlockV1 } from "@/lib/coach/ui-blocks";

// The exact text sendText carries, one per fixed action kind (lib/coach/next-action.ts) — the
// chip's tap is a normal message, same path as any quick reply, never a special client route.
const PROMPT: Record<NextActionChipBlockV1["action"], string> = {
  log_meal: "Let's log my next meal.",
  confirm_rule: "Let's confirm that rule.",
  check_label: "Let's check that food's label.",
  pick_suggestion: "Show me suggestions.",
};

export default function NextActionChipBlock({ block, ctx }: {
  block: NextActionChipBlockV1;
  ctx: CoachBlockContext;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden || !ctx.isLatestAssistant) return null;
  return (
    <div className="flex justify-end pl-8" aria-label="Next best action">
      <button type="button" className="tap pill shrink-0" style={{ minHeight: 44 }}
        onClick={() => { if (ctx.sendText(PROMPT[block.action]) !== false) setHidden(true); }}>
        <span className="pill-in flex h-full min-h-[42px] items-center px-4 text-caption text-charcoal">
          {block.label}</span>
      </button>
    </div>
  );
}
