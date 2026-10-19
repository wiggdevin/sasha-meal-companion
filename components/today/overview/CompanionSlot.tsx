"use client";

import type { OverviewData } from "@/components/today/overview/types";

/**
 * The companion's place in the Overview face (UI makeover §4 item 4, §5): one 64 px labelled row that
 * opens in place, nothing when the account hides it. Owned by W3; until then it renders nothing.
 */
export default function CompanionSlot(_props: {
  data: OverviewData;
  /** True while the Overview face is on show. */
  active: boolean;
}) {
  return null;
}
