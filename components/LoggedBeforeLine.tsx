"use client";

import { useMemo } from "react";
import { loggedBefore } from "@/lib/log/recent-meals";
import { loadStore } from "@/lib/store";

/** "Oct 12": the day an earlier entry was filed under. */
function shortDay(iso: string): string {
  const day = new Date(`${iso}T12:00:00`);
  return Number.isNaN(day.getTime()) ? iso
    : day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * W123 (T5): "You logged this before" on a capture review, when every line is matched to a food
 * and this account logged exactly those foods on an earlier entry. Read from the
 * account's own days, again whenever a line is matched to another food; nothing when there is no such entry.
 */
export default function LoggedBeforeLine({ refs }: { refs: readonly (string | null)[] }) {
  const key = refs.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const before = useMemo(() => loggedBefore(loadStore().days, refs), [key]);
  if (!before) return null;
  return <p className="m-0 text-caption text-graphite" data-logged-before="">
    You logged this before, on {shortDay(before.date)}.</p>;
}
