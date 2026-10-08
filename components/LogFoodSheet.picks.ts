/**
 * The log sheet's picks, as the durable commit path takes them (calc audit #15).
 *
 * `lib/log/picked-commit.ts` owns the commit: it mints a ref for a bundled or account food and
 * builds the one request and the one card. This file only says what the sheet picked, in that
 * module's `LogPick` shape, and how a pick that could not be sent is explained to the user. It also
 * holds the label path (`logLabelFood`), which is the same single account pick from app/page.tsx.
 */
import { AccountChanged } from "@/lib/device/account";
import { loggedFoodFor, mineAsDb, type DbFood, type DbPortion } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { committedEntry, outcomeFor } from "@/lib/log-commit-client";
import {
  commitPickedFoods, localOnlyCard, sheetPreview, type LogPick, type NotSent,
} from "@/lib/log/picked-commit";
import { addExtra, upsertExtra } from "@/lib/store";
import type { LoggedFood, SlotId } from "@/lib/types";

/**
 * The pick for a card `sheetCard` built. A food from the account's own list is an `account` pick;
 * anything else is a `bundled` food-db pick. The card goes as built: its qty of the chosen portion
 * and that portion's real mass, which the commit stores as is ("1 each" at the unit weight, "100 g"
 * at exactly 100 g). It is never converted to fractional units first.
 */
export function pickForCard(picked: DbFood, card: LoggedFood, mine: Record<string, Food>): LogPick {
  const food = picked.sr === "their list" ? mine[picked.id] : undefined;
  return food ? { source: "account", food, card } : { source: "bundled", card };
}

/**
 * The card the bundled/own-food portion view shows and logs for `qty` of `portion`, with the grams
 * and macros the commit will store (`sheetPreview`, lib/log/picked-commit.ts): the calories shown
 * are the calories stored, by the commit's own rules rather than a copy of them. A food with no
 * known weight, or no known numbers, keeps `loggedFoodFor`'s entered serving.
 *
 * `massUnknown` carries over from the preview (t17 gap 3): the meal card the commit builds and the
 * card this sheet shows must agree on whether the mass is known, or the two would read differently
 * for the same pick.
 */
export function sheetCard(
  picked: DbFood, portion: DbPortion, qty: number, extra: { id: string; at: string },
  mine: Record<string, Food>,
): LoggedFood {
  const base = loggedFoodFor(picked, portion, qty, extra);
  const { grams, macros, massUnknown } = sheetPreview(pickForCard(picked, base, mine));
  return { ...base, grams, macros, ...(massUnknown ? { massUnknown } : {}) };
}

/** One short line for a log that stayed on this phone. Names the foods at fault when it can. */
export function localOnlyMessage(result: NotSent): string {
  const names = [...new Set(result.picks.map((p) => p.card.name))];
  if (result.status === "unknown_weight" && names.length > 0) {
    const which = names.length === 1 ? names[0] : names.join(", ");
    return `Saved on this phone only. ${which} has no known weight.`;
  }
  if (result.status === "invalid_qty") return "Saved on this phone only. The amount could not be sent.";
  return "Saved on this phone only. It could not reach your account.";
}

/** The card a typed label is logged as: one of the food's own units, its real grams when known. */
export function labelCard(food: Food, at: Date): LoggedFood {
  const db = mineAsDb(food);
  // The time alone is not unique: a past day's logs share their slot's clock time.
  const id = `${at.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}-lbl`;
  return sheetCard(db, db.portions[0], 1, { id, at: at.toISOString() },
    { [food.id]: food });
}

export type LabelLog =
  | { kind: "committed"; date: string; entry: LoggedFood; message: string | null }
  | { kind: "local"; entry: LoggedFood; message: string }
  | { kind: "refused"; message: string }
  | { kind: "stopped" };

/**
 * "Type it from the label" logs the new food once, through the durable path. A food that cannot
 * be sent (no known weight, offline on first use) keeps the local card and says so; a refusal
 * keeps nothing, since the server said no. Nothing is ever both committed and added locally.
 */
export async function logLabelFood(food: Food, slot: SlotId, at = new Date()): Promise<LabelLog> {
  const card = labelCard(food, at);
  try {
    const sent = await commitPickedFoods({ picks: [{ source: "account", food, card }], slot, at });
    if (sent.status !== "sent") {
      return { kind: "local", entry: localOnlyCard(card), message: localOnlyMessage(sent) };
    }
    const outcome = outcomeFor(sent.result);
    if (!outcome.keep) return { kind: "refused", message: outcome.message ?? "That did not log. Try again." };
    return { kind: "committed", date: sent.date, entry: committedEntry(sent.date, sent.entry),
      message: outcome.message };
  } catch (e) {
    if (e instanceof AccountChanged) return { kind: "stopped" };
    return { kind: "refused", message: "That did not log. Try again." };
  }
}

/** What Today hands the label flow to settle a result with. */
export type LabelPorts = {
  /** The day on screen: where a card that stayed on this phone is filed. */
  viewedDate: string;
  close: () => void;
  refresh: () => void;
  confirmLogged: () => void;
  notify: (notice: { tone: "success" | "error"; message: string }) => void;
};

/**
 * Settle a label log on Today. A refusal closes nothing and returns its message: the label sheet
 * keeps the typed draft and shows the message in place, so the serving can be sent again. Every
 * other result closes the sheet: a committed card is filed on its commit date, a local card on the
 * day on screen with its notice, and a stopped one (the account changed) adds nothing.
 */
export function settleLabelLog(logged: LabelLog, ports: LabelPorts): string | undefined {
  // The typed food is in the list either way; only the serving was refused.
  if (logged.kind === "refused") { ports.refresh(); return logged.message; }
  ports.close();
  if (logged.kind === "stopped") return undefined;
  if (logged.kind === "committed") upsertExtra(logged.date, logged.entry);
  else addExtra(ports.viewedDate, logged.entry);
  ports.refresh();
  if (logged.kind === "committed" && !logged.message) ports.confirmLogged();
  else if (logged.kind === "committed") ports.notify({ tone: "success", message: logged.message as string });
  else ports.notify({ tone: "error", message: logged.message });
  return undefined;
}

/** What a label submit answers while an earlier one is still saving: a pending notice, not success. */
export const LABEL_STILL_SAVING = "Still saving the last one.";

/**
 * Label logs scoped to the attempt and the sheet that started them. Today calls `opened()` each
 * time the label sheet opens. One attempt runs at a time: a submit that overlaps it — a double tap,
 * or a new sheet opened while the last one is still saving — answers `LABEL_STILL_SAVING`, which
 * the sheet shows and lets the user retry. `run` is told whether its sheet is still the open one,
 * so an old attempt never closes a newer sheet.
 */
export function labelAttempts() {
  let sheet = 0;
  let running = 0;
  let next = 0;
  return {
    opened(): void { sheet += 1; },
    async submit(run: (isCurrentSheet: () => boolean) => Promise<string | void>): Promise<string | void> {
      if (running !== 0) return LABEL_STILL_SAVING;
      const attempt = ++next;
      const from = sheet;
      running = attempt;
      try {
        return await run(() => sheet === from);
      } finally {
        if (running === attempt) running = 0;
      }
    },
  };
}
