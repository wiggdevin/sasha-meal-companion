import { freshnessLine, type Freshness } from "@/lib/dev/freshness";

/** A loud strip at the top in `next dev` when this checkout is behind main (lib/dev/freshness.ts).
 * It flows in the document (not `fixed`), so it pushes the page down instead of covering the
 * header and taking its taps. `relative` keeps it painted above the fixed Harvest ground. */
export default function DevFreshnessBanner() {
  if (process.env.NODE_ENV !== "development") return null;
  let value: Freshness | null = null;
  try { value = JSON.parse(process.env.NEXT_PUBLIC_DEV_FRESHNESS ?? "null") as Freshness | null; }
  catch { value = null; }
  const line = freshnessLine(value);
  if (!line) return null;
  return <div role="alert" className="relative z-[100] w-full bg-alert px-4 py-2 text-center text-caption text-on-primary">
    {line}
  </div>;
}
