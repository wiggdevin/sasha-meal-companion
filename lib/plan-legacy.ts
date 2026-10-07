/** Historical first-client slot schedule. Never used by account layout resolution. */
import type { DayType, SlotId } from "./types";

/** Slot order per day type. targets.md §5. */
export const SLOT_ORDER: Record<DayType, SlotId[]> = {
  "training-10": ["coffee", "pouches-pre", "meal-1", "meal-2", "meal-3"],
  "training-7-fasted": ["coffee", "post-refuel", "meal-1", "meal-2", "meal-3"],
  rest: ["coffee", "meal-1", "meal-2", "meal-3", "hot-chocolate"],
};

/**
 * Base clock times per day type, targets.md §5.
 *
 * ASSUMPTION: targets.md gives "optional" for rest-day hot-chocolate with no
 * clock time. The PRD (§7.1 table) says only "optional" too. We default it
 * to 20:00 (after the 19:00 meal-3) as a reasonable evening slot.
 */
export const BASE_SLOT_TIMES: Record<DayType, Partial<Record<SlotId, string>>> = {
  "training-10": {
    coffee: "08:00",
    "pouches-pre": "08:30",
    "meal-1": "11:30",
    "meal-2": "15:00",
    "meal-3": "19:00",
  },
  "training-7-fasted": {
    coffee: "06:15",
    "post-refuel": "08:15",
    "meal-1": "11:00",
    "meal-2": "15:00",
    "meal-3": "19:00",
  },
  rest: {
    coffee: "08:00",
    "meal-1": "11:00",
    "meal-2": "15:00",
    "meal-3": "19:00",
    "hot-chocolate": "20:00", // ASSUMPTION — see comment above
  },
};
