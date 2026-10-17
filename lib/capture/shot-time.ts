/**
 * When a plate photo's meal was eaten (W125, T2): the photo's own shot time, else the moment the
 * camera handed the file over, else the capture's usual time (the viewed day's slot, or now).
 *
 * A shot time is used only on the capture's own day in its zone, and never more than a few
 * minutes ahead of now: the propose call and the slot were both chosen for that day, and the
 * commit refuses an `eaten_at` whose local date is not `local_date` (lib/log/contract.ts). A photo
 * from another day keeps the capture's usual time rather than moving the meal. Pure.
 */
import { localDateFor } from "@/lib/log/contract";

/** A phone clock a little ahead of the server's still counts as now. */
const FUTURE_SLACK_MS = 5 * 60_000;

export type PhotoTimes = { exif: Date | null; picked: Date | null };

export function photoEatenAt(
  times: PhotoTimes, ctx: { localDate: string; tz: string; now: Date },
): { at: Date; source: "photo" | "picked" } | null {
  for (const [at, source] of [[times.exif, "photo"], [times.picked, "picked"]] as const) {
    if (at === null || !Number.isFinite(at.getTime())) continue;
    if (at.getTime() > ctx.now.getTime() + FUTURE_SLACK_MS) continue;
    if (localDateFor(at.toISOString(), ctx.tz) !== ctx.localDate) continue;
    return { at, source };
  }
  return null;
}

/** "08:15" in `tz`, for the confirm sheet's time control. */
export function clockIn(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/**
 * The instant at `clock` ("HH:MM") on `localDate` in `tz`, or null for a malformed clock. Found by
 * correcting a UTC guess with the zone's own offset at that guess, twice, so a DST day lands right.
 */
export function atClock(localDate: string, clock: string, tz: string): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const time = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!date || !time || Number(time[1]) > 23 || Number(time[2]) > 59) return null;
  const wanted = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]),
    Number(time[1]), Number(time[2]));
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const shown = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDateFor(new Date(guess).toISOString(), tz) ?? "");
    const [h, m] = clockIn(new Date(guess), tz).split(":").map(Number);
    if (!shown) return null;
    const shownUtc = Date.UTC(Number(shown[1]), Number(shown[2]) - 1, Number(shown[3]), h, m);
    guess += wanted - shownUtc;
  }
  const at = new Date(guess);
  return localDateFor(at.toISOString(), tz) === localDate ? at : null;
}
