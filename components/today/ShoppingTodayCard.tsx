"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShoppingBasket } from "lucide-react";
import { onAccountGone, onAccountReady } from "@/lib/device/account";
import { getShoppingPeriod, listShoppingPeriods } from "@/lib/shopping-client";
import type { ShoppingLine } from "@/lib/shopping/types";
import RuleMark from "@/components/ui/RuleMark";
import { ruleMarkReason } from "@/lib/rule-mark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";

/** What is left to buy on the list that covers `today`, or null when there is nothing to show. */
export async function openShoppingItems(today: string): Promise<ShoppingLine[]> {
  const periods = await listShoppingPeriods();
  const covering = periods.find((row) => row.startDate <= today && row.endDate >= today);
  if (!covering) return [];
  return (await getShoppingPeriod(covering.id)).lines.filter((line) => !line.checked);
}

/**
 * One mark for the card: the worst verdict among the open items (blocked before unknown). With one
 * marked item the reason is the server's own sentence; with several it counts each kind, and only
 * a blocked item is called off the rules (an unknown one only needs a check).
 */
export function listRuleMark(items: readonly ShoppingLine[]): RuleMarkValue | null {
  const marks = items.flatMap((line) => line.ruleMark ? [line.ruleMark] : []);
  if (marks.length === 0) return null;
  if (marks.length === 1) return marks[0];
  const blocked = marks.filter((mark) => mark.verdict === "blocked").length;
  const unknown = marks.length - blocked;
  const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
  const parts = [blocked > 0 && `${count(blocked)} off your food rules`, unknown > 0 && `${count(unknown)} to check`]
    .filter(Boolean).join(", ");
  return { verdict: blocked > 0 ? "blocked" : "unknown", reason: `${parts[0]!.toUpperCase()}${parts.slice(1)}.` };
}

/**
 * Today's shopping nudge (owner ask 2026-10-02): the list's open items, one tap from the Shopping
 * tab. Silent when shopping is off for the account, the list is empty, or the read fails.
 */
export default function ShoppingTodayCard({ enabled, today }: { enabled: boolean; today: string }) {
  const [items, setItems] = useState<ShoppingLine[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => void openShoppingItems(today).then((next) => { if (live) setItems(next); })
      .catch(() => { if (live) setItems([]); });
    read();
    const onReturn = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onReturn);
    // Another account's items never show, even for the moment a switch takes (DeepSeek round 7).
    const gone = onAccountGone(() => setItems([]));
    const ready = onAccountReady(() => read());
    return () => { live = false; document.removeEventListener("visibilitychange", onReturn); gone(); ready(); };
  }, [enabled, today]);
  if (!enabled || items.length === 0) return null;
  const names = items.slice(0, 3).map((line) => line.name).join(", ");
  const mark = listRuleMark(items);
  return <div className="shell"><Link href="/foods#shopping" className="tap surface flex min-h-12 items-center gap-3 px-5 py-4">
    <ShoppingBasket size={20} aria-hidden="true" className="shrink-0 text-charcoal" />
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-body-md font-medium text-charcoal">{items.length} to buy</span>
        <RuleMark mark={mark} variant="tag" /></span>
      <span className="truncate text-tiny text-muted">{names}{items.length > 3 ? ` and ${items.length - 3} more` : ""}</span>
      {mark && <span aria-hidden="true" className="break-words text-tiny text-muted">{ruleMarkReason(mark)}</span>}
    </span>
  </Link></div>;
}
