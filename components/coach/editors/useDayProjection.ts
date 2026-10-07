"use client";

import { useEffect, useState } from "react";
import type { DayProjection } from "@/components/ProjectedDayTotals";
import { LOG_QUEUED_EVENT } from "@/lib/log-commit-client";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";

export function useDayProjection(localDate: string, active = true): DayProjection | undefined {
  const [projection, setProjection] = useState<DayProjection>();
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const day = resolveDay(loadStore(), localDate);
      setProjection({ consumed: day.consumed, targets: day.targets });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(LOG_QUEUED_EVENT, read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener(SYNCED_EVENT, read);
      window.removeEventListener(LOG_QUEUED_EVENT, read);
      window.removeEventListener("focus", read);
    };
  }, [active, localDate]);
  return projection;
}
