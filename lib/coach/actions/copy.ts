/**
 * The small wording helpers the action cards share: a slot's spoken name, a food's display case
 * and a shift's direction. Moved out of components/CoachActionCard.tsx with the per-kind titles.
 *
 * Pure.
 */

export function slotName(slot: string): string {
  return slot.replace("meal-", "meal ").replace("pouches-pre", "pre-training carbs")
    .replace("post-refuel", "post-training refuel").replace("hot-chocolate", "hot chocolate");
}

/** "Sat, Oct 3" for a YYYY-MM-DD local date: the calendar day itself, in no time zone. */
export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function displayName(name: string): string {
  return name.length === 0 ? name : name[0].toLocaleUpperCase() + name.slice(1);
}

export function direction(minutes: number): string {
  return minutes > 0 ? `${minutes} min later` : `${Math.abs(minutes)} min earlier`;
}

/** One grounded item as the thread memory line names it. */
export function itemLine(item: { name: string; grams: number }): string {
  return `${item.name} ${Math.round(item.grams)} g`;
}
