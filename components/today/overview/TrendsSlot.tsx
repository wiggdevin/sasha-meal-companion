"use client";

import type { OverviewData } from "@/components/today/overview/types";

/**
 * "Your week" in the Overview face (UI makeover §4 item 5, §4.1): three mini charts that open big in
 * place. Owned by W4; until then it renders nothing.
 */
export default function TrendsSlot(_props: {
  data: OverviewData;
  /** True while the Overview face is on show. */
  active: boolean;
}) {
  return null;
}
