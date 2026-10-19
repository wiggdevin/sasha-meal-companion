import { dayHeading } from "@/lib/today/calendar";

/**
 * Today's visible page title (UI makeover §2.2): "Today" with the short date over it, or the
 * viewed day's weekday with "Yesterday · 30 Sep" / "Tomorrow · 2 Oct" / the short date over it.
 */
export function todayPageTitle(viewedDate: string, today: string): { title: string; eyebrow: string } {
  const heading = dayHeading(viewedDate, today);
  const title = viewedDate === today
    ? "Today"
    : new Date(`${viewedDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" });
  const relative = heading.title === "Yesterday" || heading.title === "Tomorrow";
  return { title, eyebrow: relative ? `${heading.title} · ${heading.short.slice(4)}` : heading.short };
}
