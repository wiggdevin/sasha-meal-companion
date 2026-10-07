import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The viewed day, read once for a suggestion build: it sizes the target and answers the build's
 * clock ports — the named slot's planned time on that date ("07:30", the saved schedule included,
 * lib/plan-schedule.ts), so a Plan-sheet turn (whose own clock is noon of that date) is read as
 * breakfast, lunch or dinner by the slot, else the turn's own clock time in the account's zone.
 */
export function viewedDay(admin: SupabaseClient, userId: string,
  clock: { tz: string; date: string; now?: string }, slot: string | undefined) {
  const viewed = import("@/lib/server/day-context").then(({ buildDayContext }) =>
    buildDayContext(admin, userId, clock.date, clock.tz, slot));
  return { viewed,
    slotClock: async (id: string) => (await viewed).slots.find((row) => row.slot === id)?.time ?? null,
    timeOfDay: () => new Intl.DateTimeFormat("en-US", { timeZone: clock.tz, hour: "numeric",
      minute: "2-digit" }).format(clock.now ? new Date(clock.now) : new Date()) };
}
