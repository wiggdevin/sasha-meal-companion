"use client";

import { useState } from "react";
import type { CoachBlockContext } from "@/components/coach/blocks/context";
import type { QuickRepliesBlockV1 } from "@/lib/coach/ui-blocks";

export default function QuickRepliesBlock({ block, ctx }: {
  block: QuickRepliesBlockV1;
  ctx: CoachBlockContext;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden || !ctx.isLatestAssistant) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2 pl-8" aria-label="Suggested replies">
      {block.options.map((option) => (
        <button key={option} type="button" className="tap pill shrink-0" style={{ minHeight: 44 }}
          // A declined send (offline, restoring) keeps the options, so nothing vanishes unsent.
          onClick={() => { if (ctx.sendText(option) !== false) setHidden(true); }}>
          <span className="pill-in flex h-full min-h-[42px] items-center px-4 text-caption text-charcoal">
            {option}</span>
        </button>
      ))}
    </div>
  );
}
