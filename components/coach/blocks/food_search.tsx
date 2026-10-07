"use client";

import { useState } from "react";
import Link from "next/link";
import type { CoachBlockContext, FoodBlockRef } from "@/components/coach/blocks/context";
import type { FoodSearchBlockV1 } from "@/lib/coach/ui-blocks";
import KcalText from "@/components/ui/KcalText";
import Tag from "@/components/ui/Tag";
import Notice from "@/components/ui/Notice";

const META = "text-tiny font-normal text-muted";
const STATUS = "text-tiny font-normal text-graphite";

function refOf(row: FoodSearchBlockV1["results"][number]): FoodBlockRef {
  return { foodRefId: row.foodRefId, revisionId: row.revisionId, name: row.name,
    blocked: row.blocked === true || row.status === "avoid" };
}

export default function FoodSearchBlock({ block, ctx }: {
  block: FoodSearchBlockV1;
  ctx: CoachBlockContext;
}) {
  const [changed, setChanged] = useState<Partial<Record<string, "eats" | "avoid">>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "neutral"; title: string } | null>(null);
  const desired = block.intent === "eats" ? "eats" : block.intent === "avoid" ? "avoid" : null;

  async function act(row: FoodSearchBlockV1["results"][number]): Promise<void> {
    if (busy) return;
    setBusy(row.foodRefId); setNotice(null);
    try {
      const saved = block.intent === "log" ? await ctx.logFood(refOf(row))
        : block.intent === "eats" ? await ctx.markEats(refOf(row)) : await ctx.markAvoid(refOf(row));
      if (typeof saved === "string") setNotice({ tone: "neutral", title: saved });
      if (desired) setChanged((current) => ({ ...current, [row.foodRefId]: desired }));
    } catch (cause) {
      setNotice({ tone: "error", title: cause instanceof Error ? cause.message : "That did not save. Try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="shell rounded-2xl!">
      <div className="surface flex flex-col rounded-2xl!" style={{ padding: "4px 12px" }}>
        {block.results.map((row, index) => {
          const status = changed[row.foodRefId] ?? row.status;
          const blocked = row.blocked === true || status === "avoid";
          const alreadyMarked = desired !== null && status === desired;
          const label = block.intent === "log" ? (blocked ? "Log anyway" : "Log")
            : block.intent === "eats" ? "Eats" : "Avoid";
          return <div key={`${row.foodRefId}:${row.revisionId}`}
            className={`flex min-h-16 items-center gap-3 py-2 ${
              index < block.results.length - 1 ? "border-b border-hairline" : ""}`}>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-caption font-normal">{row.name}</span>
              <span className={`flex flex-wrap items-center gap-2 ${META}`}>
                <span>{row.kcalPer100g == null ? "Calories unavailable" : <KcalText text={`${Math.round(row.kcalPer100g)} kcal / 100 g`} />}</span>
                {status !== "neutral" && <Tag tone={status === "eats" ? "sage" : "red"} size="sm">
                  {status === "eats" ? "In Eats" : "Avoid"}</Tag>}
                {blocked && <span className="font-normal text-alert">Blocked</span>}
              </span>
            </span>
            {alreadyMarked ? <span className={STATUS}>{label}</span> : (
              <button type="button" disabled={busy !== null} onClick={() => void act(row)}
                className="tap pill shrink-0 disabled:opacity-40" style={{ minHeight: 44 }}>
                <span className="pill-in flex h-full min-h-[42px] items-center px-3 text-caption text-charcoal">
                  {busy === row.foodRefId ? "Saving…" : label}
                </span>
              </button>
            )}
          </div>;
        })}
        {notice && <Notice tone={notice.tone} title={notice.title} className="my-2" />}
        {block.truncated && <Link className="tap flex items-center self-end px-1 text-sm underline"
          style={{ minHeight: 44 }}
          href={`/foods?search=${encodeURIComponent(block.query)}`}>Search all foods</Link>}
      </div>
    </div>
  );
}
