import type { ResolvedDay } from "@/lib/types";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Status = "all done" | "partially done" | "missed" | "not due yet" | "unplanned";

function statusFor(day: ResolvedDay, today: string): Status {
  if (day.date > today) return "not due yet";
  const planned = day.slots.filter((slot) => slot.slot !== "hot-chocolate" && slot.meal !== null);
  if (planned.length === 0) return day.extras.length > 0 ? "partially done" : "unplanned";
  const eaten = planned.filter((slot) => slot.eaten).length;
  if (eaten === 0) return day.date === today ? "not due yet" : "missed";
  return eaten === planned.length ? "all done" : "partially done";
}

const color: Record<Status, string> = {
  "all done": "var(--color-primary)",
  "partially done": "var(--color-gauge-fat)",
  missed: "var(--color-alert)",
  "not due yet": "rgba(0,0,0,0.12)",
  unplanned: "rgba(0,0,0,0.12)",
};

export default function WeekGrid({ days, today }: { days: ResolvedDay[]; today: string }) {
  return (
    <div className="shell">
      <div className="surface grid grid-cols-7 gap-1 p-2" role="list" aria-label="This week">
        {days.map((day, index) => {
          const status = statusFor(day, today);
          const current = day.date === today;
          const month = MONTHS[Number(day.date.slice(5, 7)) - 1];
          return (
            <div key={day.date} role="listitem">
              <a href={`/?d=${day.date}`}
                aria-label={`${WEEKDAYS[index]} ${Number(day.date.slice(-2))} ${month}, ${status}`}
                className={`tap flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-[24px] ${current ? "chip-on" : ""}`}>
                <span className="text-[12px] uppercase tracking-[.2em]">{WEEKDAYS[index][0]}</span>
                <span className="text-caption tabular-nums">{Number(day.date.slice(-2))}</span>
                {status === "unplanned" ? (
                  <span className="text-[12px] leading-none text-muted" aria-hidden="true">—</span>
                ) : (
                  <span className="h-2 w-2 rounded-full" aria-hidden="true"
                    style={current && status === "not due yet"
                      ? { background: "currentColor", opacity: 0.4 } : { background: color[status] }} />
                )}
                <span className="sr-only">{status === "unplanned" ? "Not planned" : status}</span>
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
