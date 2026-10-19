/**
 * The Day card's one data contract (UI makeover W0, docs/plans/2026-10-19-ui-makeover.md §2.1, §4).
 * Today builds one `OverviewData` and hands it to the Day card; the card's header (the day type and
 * the cup), the Calendar face and the Overview face all read from it. It holds everything the card's
 * props used to carry: the live widget's panel data, the old Board's fields, the body read and the
 * viewed day against today.
 *
 * Frozen once W0 merges (plan §8): fields are added, never removed or retyped. It names no module a
 * later workstream deletes, so `DayBoard`, `DayOverview` and `LiveWidget` can go without touching it.
 */
import type { useActionFeedback } from "@/components/ui/ActionFeedback";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import type { NextMeal, WeekSummary } from "@/lib/today/board";
import type { OrbitBody, OrbitWater } from "@/lib/today/health-orbit";
import type { DayType, Macros, SlotId, Store } from "@/lib/types";

/** The viewed day against today: today is read by the hour, a past day whole, a future day not at all. */
export type OverviewWhen = "today" | "past" | "future";

/** The page's feedback props for one write (`useActionFeedback().controlPropsFor`). */
export type OverviewControl = ReturnType<ReturnType<typeof useActionFeedback>["controlPropsFor"]>;

export type OverviewData = {
  /** The viewed day and today, ISO dates. */
  date: string;
  today: string;
  when: OverviewWhen;
  /** The viewed day's type; training days wear the orange mark (DESIGN.md, Yellow, orange, red). */
  dayType?: DayType;

  // ---- The day's numbers (the live widget's PanelData, with targets that may be missing) ----
  /** The revision in force on the viewed day; null before the account's first one. Never invented. */
  targets: Macros | null;
  consumed: Macros;
  /** A partly measured recipe serving in the day (#21): eaten is "at least", left is "at most". */
  partial: boolean;
  water?: OrbitWater;
  /** Adds one stored cup. */
  onAddCup?: () => void;
  /** Writes the day's new total in cups, once (a scrub or a keyboard amount). */
  onSetCups?: (cups: number) => void;
  /** Phase 19 R2: the "Rebalance my day" panel (`useRebalancePanel`), absent while gated off. */
  rebalance?: RebalancePanel;
  /** UI-owned: takes the user to a card's slot on Today. Never a writer. */
  onOpenSlot?: (slot: SlotId) => void;

  // ---- The old Board's fields ----
  next: NextMeal | null;
  /** Planned meals on the viewed day, so "nothing next" can say whether they are all eaten. */
  planned: number;
  onMarkEaten?: (slot: NextMeal["slot"]) => void;
  /** The page's feedback props for that slot's eaten write: the check waits while one is pending. */
  markEatenControl?: (slot: NextMeal["slot"]) => OverviewControl;
  /** This week, already summarised; or Today's plan inputs to summarise it from (read once per
   *  store): the same store and verified foods Today resolves its own day with. */
  week?: WeekSummary;
  store?: Store;
  eligibleIds?: ReadonlySet<string>;
  onSelectDate?: (date: string) => void;

  // ---- The body ----
  /** The viewed day's shared body read (activity and recovery). */
  body?: OrbitBody;
};
