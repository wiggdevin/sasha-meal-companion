"use client";

import { useState } from "react";
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
 * and this account logged exactly those foods on an earlier entry. Read once per draft, from the
 * account's own days; nothing when there is no such entry.
 */
export default function LoggedBeforeLine({ refs }: { refs: readonly (string | null)[] }) {
  const [before] = useState(() => loggedBefore(loadStore().days, refs));
  if (!before) return null;
  return <p className="m-0 text-caption text-graphite" data-logged-before="">
    You logged this before, on {shortDay(before.date)}.</p>;
}
