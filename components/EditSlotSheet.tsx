"use client";

import { useId, useRef, useState } from "react";
import CatalogSearch from "@/components/CatalogSearch";
import Sheet from "@/components/Sheet";
import TimeWheelSheet, { normalizeTime, stepQuarter } from "@/components/TimeWheelSheet";
import ProjectedDayTotals, { type DayProjection } from "@/components/ProjectedDayTotals";
import { MacroFigure } from "@/components/nutrition/MacroText";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
import RuleMark from "@/components/ui/RuleMark";
import { lineRuleMarks } from "@/components/SlotRuleMarks";
import { componentFor, type Food } from "@/lib/foods";
import {
  addComponent, componentsForSlot, replaceComponent, slotDifference, stepComponent,
  sumComponents,
} from "@/lib/plan/slot-override";
import { completeComponentFromCatalog, type Per100g } from "@/lib/plan/catalog-component";
import { catalogSearchEnabled, getFoodDetail, type CatalogRow } from "@/lib/catalog-client";
import type { FoodComponent, Macros, RuleMark as RuleMarkValue, SlotOverride } from "@/lib/types";

/* Rows are ivory cards with a hairline (E0: never a shadow inside the card that hosts the flow);
   every button is the shared Button (DESIGN.md §Buttons). */
const ROW = "rounded-2xl border border-hairline bg-surface";
const ROW_TITLE = "text-caption font-normal";
const ROW_META = "text-tiny font-normal text-muted";
const LABEL = "text-tiny font-normal text-graphite";
const MUTED = "text-tiny font-normal text-muted";

/** The secondary button, full width, or sized to its words at the row's start. */
function PillButton({
  children, onClick, ariaLabel, align = "center",
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  align?: "center" | "start";
}) {
  return <Button aria-label={ariaLabel} onClick={onClick} block={align === "center"}
    className={align === "start" ? "self-start" : undefined}>{children}</Button>;
}

/**
 * The minus and plus either side of a line. One tap changes how much of it the user had, and stepping
 * the last one off takes the line away — so a line needs no sub-menu and no separate remove.
 */
function StepButton({
  children, onClick, ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
}) {
  return <Button shape="circle" aria-label={ariaLabel} onClick={onClick} className="text-graphite">{children}</Button>;
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const signed = (n: number) => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)));

/**
 * What the user actually had in one slot — Phase A of docs/plans/2026-09-14-slot-item-editing.md.
 *
 * The card renders its components as one joined sentence, so there has never been anything to tap.
 * This sheet gives every line its own control: change how much, take it off, put it back, or add
 * something the plan did not have.
 *
 * The slot re-sums from what is on it and shows the difference against its target. It does NOT
 * resize the other lines to hold that target — this records what the user ate, it is not a second
 * planner. `lib/scaling.ts` still sizes the authored plan and still never moves protein.
 *
 * The edit is for this date only. "Back to the plan" clears it.
 */
export default function EditSlotSheet({
  open, label, planned, override, target, foods, note, time, projection, replaced, ruleMarks,
  onSave, onClose, onSwap,
}: {
  open: boolean;
  label: string;
  planned: FoodComponent[];
  override: SlotOverride | undefined;
  target: Macros | undefined;
  projection?: DayProjection;
  replaced?: Macros;
  /** The slot's `componentRuleMarks`, one per `planned` line (resolveDay); a line keeps its mark by name. */
  ruleMarks?: (RuleMarkValue | null)[];
  foods: Record<string, Food>;
  /** `null` means "back to the plan" — drop the override for this slot. */
  note?: string;
  time?: string;
  onSave: (components: FoodComponent[] | null, note?: string, time?: string) => void | Promise<void>;
  onClose: () => void;
  onSwap?: () => void;
}) {
  // Seeded once, on mount. The Today screen renders this sheet with a key of the slot it is
  // editing, so opening a different slot mounts a fresh one rather than re-seeding in an effect.
  const [working, setWorking] = useState<FoodComponent[]>(
    () => componentsForSlot(planned, override));
  const [picking, setPicking] = useState<"add" | number | null>(null);
  /** A catalog row the user has chosen, waiting for how much of it the user had. */
  const [pending, setPending] = useState<
    { name: string; per100g: Per100g; grams: number } | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  const [workingNote, setWorkingNote] = useState(note ?? "");
  const [workingTime, setWorkingTime] = useState(time ?? "");
  const [wheelOpen, setWheelOpen] = useState(false);
  const timeId = useId();
  const markId = useId();
  const marks = lineRuleMarks({ components: planned, componentRuleMarks: ruleMarks, eaten: replaced !== undefined },
    working);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Closed while a save ran: the save still lands, and its "close after save" is already done. */
  const dismissed = useRef(false);
  const dismiss = () => { dismissed.current = true; onClose(); };

  async function save(components: FoodComponent[] | null, afterSave = onClose) {
    if (saving) return;
    if (time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(workingTime)) {
      setSaveError("Choose a valid meal time.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(components, workingNote.trim(), time === undefined ? undefined : workingTime);
      if (!dismissed.current) afterSave();
    } catch {
      setSaveError("Your changes could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const total = sumComponents(working);
  const difference = slotDifference(total, target);
  const eats = Object.values(foods).filter((f) => f.status === "eats");
  /** The chosen catalog row as a line, or null when it cannot state all four numbers (#20): a
   *  slot line has no "unknown", so a missing nutrient is refused rather than summed as zero. */
  const line = pending && completeComponentFromCatalog(pending.name, pending.per100g, pending.grams);

  function place(next: FoodComponent) {
    setWorking((w) => (picking === "add" || picking === null
      ? addComponent(w, next)
      : replaceComponent(w, picking, next)));
    setPicking(null);
    setPending(null);
  }

  function pick(food: Food) {
    place(componentFor(food, 1));
  }

  /**
   * A catalog row carries no macros — they live on the revision — so the row is resolved to its
   * per-100 g values first, then the user says how much of it the user had.
   */
  async function pickFromCatalog(row: CatalogRow) {
    if (row.catalogFoodId === null) return;
    setLookupFailed(false);
    const result = await getFoodDetail(row.catalogFoodId,
      row.revisionId === null ? {} : { revisionId: row.revisionId });
    if (result.kind === "ok") {
      const per100g: Per100g = {};
      for (const [code, value] of Object.entries(result.detail.per100g)) per100g[code] = value.amount;
      const preferred = result.detail.portions.find((portion) => portion.isDefault)
        ?? result.detail.portions[0];
      setPending({ name: result.detail.description, per100g, grams: preferred?.gramWeight ?? 100 });
      return;
    }
    if (result.kind === "cached") {
      const preferred = result.revision.portions.find((portion) => portion.isDefault)
        ?? result.revision.portions[0];
      setPending({
        name: result.revision.description, per100g: result.revision.per_100g,
        grams: preferred?.gramWeight ?? 100,
      });
      return;
    }
    // Blocked or missing: say so rather than adding a line with no numbers behind it.
    setLookupFailed(true);
  }

  return (
    <Sheet onClose={dismiss} title={label}>
      <fieldset disabled={saving} className="min-w-0">
      <div className="flex flex-col gap-3">
        {picking !== null && pending !== null ? (
          <>
            <p className={LABEL}>How much {pending.name.toLowerCase()} did you have?</p>
            <div className="flex items-center gap-2">
              <input
                aria-label="Grams"
                inputMode="numeric"
                value={String(pending.grams)}
                onChange={(e) => {
                  const grams = Number(e.target.value.replace(/[^0-9.]/g, ""));
                  setPending({ ...pending, grams: Number.isFinite(grams) ? grams : 0 });
                }}
                className="well tap h-[52px] w-28 rounded-[12px] bg-transparent px-4 text-body-sm font-normal outline-none"
              />
              <span className={MUTED}>grams</span>
              {line && <span className={MUTED}>· {Math.round(line.macros.kcal)} kcal</span>}
            </div>
            {line ? (
              <Button variant="primary" size="lg" block onClick={() => place(line)}>
                That is what I had
              </Button>
            ) : (
              <Notice tone="error" title="This food is missing some nutrition numbers. Pick another." />
            )}
            <PillButton onClick={() => setPending(null)}>Pick something else</PillButton>
          </>
        ) : picking !== null ? (
          <>
            <p className={LABEL}>{picking === "add" ? "What else did you have?" : "What did you have instead?"}</p>
            {catalogSearchEnabled() && (
              <CatalogSearch mine={foods} autoFocus onPick={(row) => void pickFromCatalog(row)} />
            )}
            {lookupFailed && (
              <Notice tone="error" title="That food could not be read right now. Pick another, or one of yours below." />
            )}
            <p className={LABEL}>Or one of your foods</p>
            <div className="flex flex-col gap-2">
              {eats.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-label={`Pick ${f.name}`}
                  onClick={() => pick(f)}
                  className={`tap flex w-full items-center gap-3 px-3.5 py-3 text-left ${ROW}`}
                >
                  <span className={`min-w-0 flex-1 truncate ${ROW_TITLE}`}>{f.name}</span>
                  <span className={`shrink-0 ${ROW_META}`}>{f.role}</span>
                </button>
              ))}
            </div>
            <PillButton onClick={() => setPicking(null)}>Never mind</PillButton>
          </>
        ) : (
          <>
            {/* No native time picker (FluidVoice U05): type the time, step it by 15 minutes, or
                choose it on the quarter-hour wheel. Every path lands in the same working time. */}
            {time !== undefined && <div className="flex flex-col gap-2">
              <label htmlFor={timeId} className={LABEL}>Meal time</label>
              <div className="flex min-w-0 items-center gap-2">
                <StepButton ariaLabel="Earlier meal time"
                  onClick={() => setWorkingTime((t) => stepQuarter(t, -1))}>−</StepButton>
                <input id={timeId} type="text" inputMode="numeric" autoComplete="off" placeholder="HH:MM"
                  value={workingTime} onChange={(e) => setWorkingTime(e.target.value)}
                  onBlur={() => setWorkingTime((t) => normalizeTime(t) ?? t)}
                  className="well h-[52px] min-w-0 flex-1 px-4 text-center text-body-sm tabular-nums" />
                <StepButton ariaLabel="Later meal time"
                  onClick={() => setWorkingTime((t) => stepQuarter(t, 1))}>+</StepButton>
                <StepButton ariaLabel="Choose meal time" onClick={() => setWheelOpen(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                  </svg>
                </StepButton>
              </div>
            </div>}
            {wheelOpen && <TimeWheelSheet value={workingTime} onChange={setWorkingTime}
              onClose={() => setWheelOpen(false)} />}
            <p className={LABEL}>What you actually had</p>

            {working.length === 0 && <Notice tone="neutral" title="Nothing in this slot." />}

            <div className="flex flex-col gap-2">
              {working.map((c, i) => (
                <div key={`${c.name}-${i}`} className="flex items-center gap-2">
                  <StepButton
                    ariaLabel={c.qty > 1 ? `One less ${c.name}` : `Take ${c.name} off`}
                    onClick={() => setWorking((w) => stepComponent(w, i, -1))}
                  >
                    −
                  </StepButton>

                  {/* The line itself is the way to change it: one tap straight to the search. */}
                  <button
                    type="button"
                    aria-label={`Change ${c.name}`}
                    aria-describedby={marks[i] ? `${markId}-${i}` : undefined}
                    onClick={() => setPicking(i)}
                    className={`tap flex min-w-0 flex-1 flex-col gap-0.5 px-3.5 py-2.5 text-left ${ROW}`}
                  >
                    {/* Stacked, the way AddFoodSheet's rows are: with a stepper either side there
                        is not enough width at 375 px to put the name and the calories on one line
                        without the name truncating to "1 pouch Fruit...". */}
                    <span className={`truncate ${ROW_TITLE}`}>{c.name}</span>
                    <span className={`truncate tabular-nums ${ROW_META}`}>
                      {fmtQty(c.qty)} {c.unit} · {Math.round(c.macros.kcal)} kcal
                    </span>
                    {/* Marked, never removed: the line stays and stays editable. */}
                    {marks[i] && <span id={`${markId}-${i}`} className="pt-1"><RuleMark mark={marks[i]} /></span>}
                  </button>

                  <StepButton
                    ariaLabel={`One more ${c.name}`}
                    onClick={() => setWorking((w) => stepComponent(w, i, 1))}
                  >
                    +
                  </StepButton>
                </div>
              ))}
            </div>

            <PillButton align="start" onClick={() => setPicking("add")}>Add something</PillButton>

            <div className="flex items-baseline justify-between pt-1">
              <span className={LABEL}><MacroFigure macro="kcal" value={total.kcal} /></span>
              {difference !== null && (
                <span className={MUTED}>
                  {difference.kcal === 0 ? "on target" : `${signed(difference.kcal)} kcal vs target`}
                </span>
              )}
            </div>

            {working.length > 0 && projection && <ProjectedDayTotals
              projection={projection} added={total} replaced={replaced}
              label={replaced ? "Updated day" : "If this meal is eaten"} />}

            <label className={`flex flex-col gap-2 ${LABEL}`}>
              Note
              <textarea value={workingNote} onChange={(e) => setWorkingNote(e.target.value)}
                rows={3} maxLength={2000} placeholder="How was this meal?"
                className="well w-full resize-y px-4 py-3 text-body-sm font-normal" />
            </label>
            {saveError && <Notice tone="error" title={saveError} />}
            <Button variant="primary" size="lg" block status={saving ? "pending" : undefined}
              onClick={() => void save(working)}>
              Save changes
            </Button>
            <PillButton onClick={() => void save(null)}>Back to the plan</PillButton>
            {onSwap && <PillButton onClick={() => void save(working, onSwap)}>Choose a different meal</PillButton>}
          </>
        )}
      </div>
      </fieldset>
    </Sheet>
  );
}
