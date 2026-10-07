"use client";

import Button from "@/components/ui/Button";
import LogMealWarnings from "@/components/coach/LogMealWarnings";
import RoleConfirm from "@/components/coach/RoleConfirm";
import { MacroLine } from "@/components/nutrition/MacroText";
import { MACROS, formatMacro, type MacroValues } from "@/components/nutrition/spec";
import Thinking from "@/components/ui/Thinking";
import { actionSpecFor, type CoachAction, type GroundedActionItem } from "@/lib/coach/actions";
import { serverLines, type ServerCard } from "@/components/coach/server-card";
import { actionCardNotes, ALREADY_UNDONE_COPY, type CoachActionStatus } from "@/components/coach/action-notes";
import { componentFromCatalog } from "@/lib/plan/catalog-component";

export { ALREADY_UNDONE_COPY, type CoachActionStatus };

const cardOf = (action: CoachAction) => actionSpecFor(action.kind)?.card;

/* Each kind's copy is its spec's `card` (lib/coach/actions/<kind>.ts).
   Design §8.5: a phone running an older build can be handed an action kind a newer server has
   added. It has no spec for it, and an unknown kind once drew a card with a blank title. The one
   thing every coach action has in common is the honest fallback. */
export function actionTitle(action: CoachAction): string {
  return cardOf(action)?.title(action) ?? "Updated your plan";
}

function actionPendingTitle(action: CoachAction): string {
  return cardOf(action)?.pending?.(action) ?? actionTitle(action);
}

function actionItems(action: CoachAction): GroundedActionItem[] {
  return cardOf(action)?.macroItems?.(action) ?? [];
}

export function actionMacroTotals(action: CoachAction): MacroValues | null {
  const items = actionItems(action);
  if (items.length === 0) return null;
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const item of items) {
    const { macros } = componentFromCatalog(item.name, { energy_kcal: item.kcalPer100g, protein: item.proteinPer100g,
      carbohydrate: item.carbsPer100g, fat_total: item.fatPer100g }, item.grams);
    for (const key of MACROS) total[key] += macros[key];
  }
  return total;
}

/** The standard nutrition text: "248 kcal · 46g PRO · 0g CAR · 5g FAT" (docs/design/KIT.md §13). */
export function actionMacroStrip(action: CoachAction): string | null {
  const t = actionMacroTotals(action);
  return t && `${formatMacro(t.kcal!)} kcal · ${formatMacro(t.protein!)}g PRO · ${formatMacro(t.carbs!)}g CAR · ${formatMacro(t.fat!)}g FAT`;
}

export function actionFlaggedCopy(flagged: string[]): string | null {
  return flagged.length ? `Marked off-plan: ${flagged.join(", ")}` : null;
}

export function actionUndoLabel(): "Undo" { return "Undo"; }

function lineItems(action: CoachAction): { name: string; grams: number | null }[] {
  return cardOf(action)?.lines?.(action) ?? [];
}

function ItemLines({ action, server }: { action: CoachAction; server?: ServerCard }) {
  const items = server ? serverLines(server) : lineItems(action);
  if (items.length === 0) return null;
  return <ul className="m-0 list-none p-0 text-tiny font-normal text-on-charcoal-muted">
    {items.map((item, index) => (
      <li key={`${item.name}-${index}`}>{item.name}{item.grams === null ? "" : ` · ${item.grams} g`}</li>
    ))}
  </ul>;
}

export default function CoachActionCard({
  action, server, status, reason, canUndo, busy = false, nutritionUnchecked = false, already = false, notices = [],
  onRetry, onUndo,
}: {
  action: CoachAction;
  server?: ServerCard; // a server-held record, drawn from its card only (components/coach/server-card.ts)
  status: CoachActionStatus;
  reason?: string;
  canUndo: boolean;
  busy?: boolean;
  /** `ApplyResult.nutritionUnchecked` (t23 #7): the save landed, but could not be checked. */
  nutritionUnchecked?: boolean;
  /** `already`: this Undo found it already undone (t23 #8). `notices`: what the save left out, a line each. */
  already?: boolean; notices?: readonly string[];
  onRetry: () => void;
  onUndo: () => void;
}) {
  const totals = server ? null : actionMacroTotals(action);
  const flagged = server ? null : actionFlaggedCopy(action.flagged);
  const title = server ? server.card.title : status === "pending" ? actionPendingTitle(action) : actionTitle(action);
  const notes = actionCardNotes({ status, already, reason, notices, nutritionUnchecked });
  return (
    <div className="meal-card ml-4" data-action-id={action.actionId}>
      <div className="meal-card-in flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-caption font-normal text-on-charcoal">{title}</h3>
            <ItemLines action={action} server={server} />
          </div>
          <span role="status" className="flex shrink-0 items-center gap-1.5 text-tiny font-normal text-on-charcoal-muted">
            {status === "pending" ? <Thinking size="compact" label="Applying…" hint="Still working…" announce={false} />
              : status === "applied" ? "Done" : status === "undoing" ? (reason ?? "Undoing…")
              : status === "undone" ? "Undone" : "Failed"}
          </span>
        </div>

        {totals && <div className="olive-panel px-3 py-2 text-tiny font-normal tabular-nums text-charcoal">
          <MacroLine values={totals} />
        </div>}
        {flagged && <p className="m-0 text-tiny font-normal text-amber">{flagged}</p>}
        {notes.map((note, index) => <p key={`${index}-${note}`} className="m-0 text-tiny font-normal text-on-charcoal-muted">{note}</p>)}
        {!server && <><LogMealWarnings action={action} /><RoleConfirm action={action} active={status === "applied"} /></>}

        {status === "failed" && <div className="flex items-center justify-between gap-3">
          <p role="alert" className="m-0 text-tiny font-normal text-on-charcoal-muted">
            {reason ?? "That did not save."}
          </p>
          <Button variant="ghost" size="sm" onClick={canUndo ? onUndo : onRetry} disabled={busy}>
            {canUndo ? "Undo again" : "Retry"}
          </Button>
        </div>}

        {((status === "applied" && canUndo) || status === "undoing") && <div className="self-start">
          <Button variant="tertiary" size="sm" onClick={onUndo} disabled={status === "undoing"}>
            {status === "undoing" ? "Undoing…" : actionUndoLabel()}
          </Button>
        </div>}
      </div>
    </div>
  );
}
