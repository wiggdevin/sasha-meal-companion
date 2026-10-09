"use client";

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { ASSISTANT_NAME } from "@/lib/brand";
import { FADES, MORPH } from "@/lib/design/motion";
import dark from "@/components/AfterDarkCards.module.css";
import { MealTargetMeters } from "@/components/ui/circle-menu";
import CatalogSearch from "@/components/CatalogSearch";
import { getFoodDetail, type CatalogRow } from "@/lib/catalog-client";
import { dbFood } from "@/lib/food-db";
import { componentFor, type Food } from "@/lib/foods";
import { componentFromCatalog, type Per100g } from "@/lib/plan/catalog-component";
import { portionForName, rememberPortion, servingOf, servingOfDbFood } from "@/lib/catalog/serving";
import { ingredientQtyLabel, stepIngredientQty } from "@/lib/plan/ingredient-step";
import { addComponent, removeComponent, replaceComponent, setComponentQty, sumComponents } from "@/lib/plan/slot-override";
import type { FoodComponent, Macros, ResolvedSlot } from "@/lib/types";
import AutoHeight from "@/components/ui/AutoHeight";
import Button from "@/components/ui/Button";
import Disclosure from "@/components/ui/Disclosure";
import Notice from "@/components/ui/Notice";
import RuleMark from "@/components/ui/RuleMark";
import { lineRuleMarks, slotRuleMark } from "@/components/SlotRuleMarks";
import { ArrowLeftRight } from "lucide-react";
import { ChevronIcon, SearchIcon } from "@/components/ui/icons";
import { CARD_SECTION } from "@/lib/design/meal-type";

const FRACTIONS: Record<string, string> = { "0.25": "¼", "0.5": "½", "0.75": "¾" };

export function formatQty(qty: number): string {
  const whole = Math.floor(qty);
  const frac = Math.round((qty - whole) * 100) / 100;
  const glyph = FRACTIONS[String(frac)];
  if (glyph) return whole > 0 ? `${whole}${glyph}` : glyph;
  return String(Math.round(qty * 100) / 100);
}

export type DayTotals = { consumed: Macros; targets: Macros | null };

type IngredientEditor = {
  foods: Record<string, Food>;
  onSave: (components: FoodComponent[]) => void | Promise<void>;
  onPreview: (macros: Macros | null) => void;
};

/* The step itself is lib/plan/ingredient-step.ts: by the food's portion when one is known (U8). */

const UNDO_MS = 5000;

/** 28 px visual button with a 44 px hit area, so the stepper fits on one line. */
/** One end of the portion pill: a 28 px glyph button with a 44 px touch area around it. */
function StepButton({ label, disabled, onClick, children }: {
  label: string; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
    className="relative flex size-7 shrink-0 items-center justify-center rounded-full text-graphite transition-[background-color,transform] duration-150 before:absolute before:-inset-2 before:content-[''] hover:bg-[rgb(var(--ink-rgb)/0.06)] active:scale-90 active:bg-[rgb(var(--ink-rgb)/0.1)] disabled:opacity-40">
    {children}
  </button>;
}

const MINUS = <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"
  strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6h7" /></svg>;
const PLUS = <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"
  strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6h7M6 2.5v7" /></svg>;

function UndoRow({ name, onUndo }: { name: string; onUndo: () => void }) {
  return <div role="status" className="flex min-h-10 items-center gap-2 py-1">
    <span className="min-w-0 flex-1 truncate text-caption text-muted">Removed {name}</span>
    <Button variant="ghost" size="sm" onClick={onUndo} aria-label={`Undo remove ${name}`} className="-mr-2">Undo</Button>
  </div>;
}

type MarkedSlot = Pick<ResolvedSlot, "components" | "componentRuleMarks" | "eaten">;

function Ingredients({ id, components, editor, marked }: { id: string; components: FoodComponent[];
  editor?: IngredientEditor; marked?: MarkedSlot }) {
  const [working, setWorking] = useState(components);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ component: FoodComponent; index: number } | null>(null);
  const shown = dirty ? working : components;
  // Each line's mark against the current food rules; never hidden, never in the way of the stepper.
  const marks = marked ? lineRuleMarks(marked, shown) : [];
  const shownRef = useRef(shown);
  useEffect(() => { shownRef.current = shown; }, [shown]);

  function change(next: FoodComponent[]) {
    shownRef.current = next;
    setWorking(next);
    setDirty(true);
    setSaveError(null);
    editor?.onPreview(sumComponents(next));
  }

  // Removal is reversible for 5 seconds (DESIGN.md: reversible change → Undo).
  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  function remove(index: number) {
    const component = shown[index];
    if (!component) return;
    setRemoved({ component, index });
    change(removeComponent(shown, index));
  }

  function undoRemove() {
    if (!removed) return;
    const current = shownRef.current;
    const at = Math.min(removed.index, current.length);
    change([...current.slice(0, at), removed.component, ...current.slice(at)]);
    setRemoved(null);
  }

  function step(index: number, direction: -1 | 1) {
    const component = shown[index];
    if (!component) return;
    const qty = stepIngredientQty(component, direction, portionForName(component.name));
    if (qty !== component.qty) change(replaceComponent(shown, index, setComponentQty(component, qty)));
  }

  async function add(row: CatalogRow) {
    if (!editor) return;
    setSearchError(null);
    let next: FoodComponent | null = null;
    if (row.offline && row.offlineFoodId) {
      if (row.offlineSource === "mine") {
        const food = editor.foods[row.offlineFoodId];
        if (food) next = componentFor(food, 1);
      } else {
        const food = dbFood(row.offlineFoodId);
        // U8: one everyday serving (the same one its search row names), remembered for the stepper.
        const portion = food ? servingOfDbFood(food).defaultPortion : null;
        if (food) next = componentFromCatalog(food.name, {
          protein: food.per100g.protein, carbohydrate: food.per100g.carbs,
          fat_total: food.per100g.fat, energy_kcal: food.per100g.kcal,
        }, portion?.grams ?? 100);
        if (food) rememberPortion(food.name, portion);
      }
    } else if (row.catalogFoodId !== null) {
      try {
        const result = await getFoodDetail(row.catalogFoodId,
          row.revisionId === null ? {} : { revisionId: row.revisionId });
        if (result.kind === "ok") {
          const per100g: Per100g = {};
          for (const [code, value] of Object.entries(result.detail.per100g)) per100g[code] = value.amount;
          const legacy = result.detail.portions.find((item) => item.isDefault) ?? result.detail.portions[0];
          const portion = servingOf(result.detail).defaultPortion
            ?? (legacy ? { label: legacy.description, grams: legacy.gramWeight } : null);
          next = componentFromCatalog(result.detail.description, per100g, portion?.grams ?? 100);
          rememberPortion(result.detail.description, portion);
        } else if (result.kind === "cached") {
          const legacy = result.revision.portions.find((item) => item.isDefault) ?? result.revision.portions[0];
          const portion = servingOf(result.revision).defaultPortion
            ?? (legacy ? { label: legacy.description, grams: legacy.gramWeight } : null);
          next = componentFromCatalog(result.revision.description, result.revision.per_100g, portion?.grams ?? 100);
          rememberPortion(result.revision.description, portion);
        }
      } catch { /* Keep the current draft when lookup fails. */ }
    }
    if (next) change(addComponent(shownRef.current, next));
    else setSearchError("That food could not be read. Try another result.");
  }

  async function save() {
    if (!editor || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await editor.onSave(working);
      setDirty(false);
      setRemoved(null);
      editor.onPreview(null);
    } catch {
      setSaveError("Changes were not saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <section aria-labelledby={`${id}-ingredients`} className="space-y-1">
    <h4 id={`${id}-ingredients`} className={`m-0 ${CARD_SECTION}`}>Ingredients</h4>
    {/* A row removed, an undo offered, search results or the save button appearing: the tray grows
        and shrinks on the card's spring instead of jumping. */}
    <AutoHeight spring="gentle">
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {shown.map((component, index) => <Fragment key={`${component.name}-${index}`}>
          {removed && removed.index === index && <UndoRow name={removed.component.name} onUndo={undoRemove} />}
          <div data-ingredient-line="">
          <div className="flex min-h-10 items-center gap-2 py-1">
            {/* A long catalog name wraps to two lines before it ellipsises, so "Game meat, deer" stays
                readable; the stepper keeps its width (Kimi K8, 2026-10-04). */}
            <span data-ingredient-name="" className="min-w-0 flex-1 line-clamp-2 break-words text-caption leading-snug text-on-charcoal"
              title={component.name}>{component.name}</span>
            {editor ? <>
              <div className={`flex h-8 shrink-0 items-center px-0.5 ${dark.stepper}`}>
                <StepButton label={`Decrease ${component.name}`} disabled={saving} onClick={() => step(index, -1)}>{MINUS}</StepButton>
                <span className="min-w-12 text-center text-tiny tabular-nums text-charcoal">{ingredientQtyLabel(component,
                  portionForName(component.name), `${formatQty(component.qty)} ${component.unit}`)}</span>
                <StepButton label={`Increase ${component.name}`} disabled={saving} onClick={() => step(index, 1)}>{PLUS}</StepButton>
              </div>
              <button type="button" aria-label={`Remove ${component.name}`} disabled={saving}
                onClick={() => remove(index)}
                className="tap -mr-3 flex size-11 shrink-0 items-center justify-center text-alert">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </> : <span className="shrink-0 text-tiny tabular-nums text-muted">{ingredientQtyLabel(component,
              portionForName(component.name), `${formatQty(component.qty)} ${component.unit}`)}</span>}
          </div>
          <RuleMark mark={marks[index]} className="pb-2" />
          </div>
        </Fragment>)}
        {removed && removed.index >= shown.length && <UndoRow name={removed.component.name} onUndo={undoRemove} />}
      </div>
      {editor && <div className="mt-1 space-y-3 pt-2">
        <CatalogSearch mine={editor.foods} maxResults={5} onPick={(row) => { void add(row); }} />
        {searchError && <Notice tone="error" title={searchError} />}
        {saveError && <Notice tone="error" title={saveError} />}
        {dirty && <Button variant="primary" block status={saving ? "pending" : undefined}
          onClick={() => { void save(); }}>Save ingredients</Button>}
      </div>}
    </AutoHeight>
  </section>;
}

export function MealDetail({ id, label, components, macros, dayTotals, prepMinutes, editor, marked, onAsk,
  onAteElse, onSearch }: {
  id: string; label: string; components: FoodComponent[]; macros: Macros; dayTotals?: DayTotals;
  prepMinutes?: number; editor?: IngredientEditor; marked?: MarkedSlot;
  /** Ask the assistant about this meal (its preparation goes through the same flow). */
  onAsk?: () => void;
  /** "Ate something else": log what was eaten instead of this planned meal. */
  onAteElse?: () => void;
  /** Search foods in a sheet, for a card without the inline ingredient editor. */
  onSearch?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const targets = dayTotals?.targets;
  const kcalShare = targets && targets.kcal > 0 ? Math.max(0, Math.round((macros.kcal / targets.kcal) * 100)) : null;
  // Opening, the panel grows on the card's own spring (MORPH) and its content fades in once it has room;
  // closing, it folds on the same spring with its words in place. The card's header never changes shape
  // (cards v4), so nothing waits on it. Closing, it is already gone for assistive tech.
  const present = useIsPresent();
  return <motion.div id={id} role="region" aria-label={`${label} details`}
    inert={!present} aria-hidden={present ? undefined : true}
    initial={reduceMotion ? false : { opacity: 0, height: 0 }}
    animate={{ opacity: 1, height: "auto" }}
    exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, height: 0, transition: { ...MORPH.frame, opacity: { ...FADES.quick, delay: 0.25 } } }}
    transition={reduceMotion ? { duration: 0 } : { ...MORPH.frame, opacity: MORPH.contentIn }}
    className="relative z-10 flow-root w-full basis-full overflow-clip">
    <div data-meal-detail="" className="space-y-3 px-3 pt-3 pb-1">
      <Ingredients id={id} components={components} editor={editor} marked={marked} />
      <div className="flex flex-col gap-1">
        <Disclosure variant="row" size="sm" bodyClassName="" spring="gentle" title="Preparation" className={dark.disclosure}
          titleClassName={CARD_SECTION}
          aside={prepMinutes != null && prepMinutes > 0 ? `${prepMinutes} min` : undefined}>
          <div className="flex flex-col items-start gap-2 pb-3">
            <p className="m-0 text-tiny text-muted">Step-by-step guidance or a substitution, for this plate.</p>
            {onAsk && <button type="button" onClick={onAsk} className={dark.ghostLink}>{`Ask ${ASSISTANT_NAME} how to make it`}</button>}
          </div>
        </Disclosure>
        {targets && <Disclosure variant="row" size="sm" bodyClassName="" spring="gentle" title="Daily share" className={dark.disclosure}
          titleClassName={CARD_SECTION}
          aside={kcalShare != null ? <><span className="kcal font-semibold">{kcalShare}%</span> of calories</> : undefined}>
          <div className="pb-3"><MealTargetMeters meal={macros} targets={targets} showHeading={false} /></div>
        </Disclosure>}
      </div>
      {/* The rare actions as plain text links, never pills (v4: "the buttons are way too big"). */}
      <p data-meal-links="" className={dark.links}>
        {onSearch && <><button type="button" onClick={onSearch} aria-label={`Search foods for ${label}`}
          className={dark.ghostLink}>Search foods</button><span aria-hidden="true">·</span></>}
        <button type="button" onClick={onAsk} aria-label={`Ask ${ASSISTANT_NAME} about ${label}`}
          className={dark.ghostLink}>{`Ask ${ASSISTANT_NAME}`}</button>
        {onAteElse && <><span aria-hidden="true">·</span><button type="button" onClick={onAteElse}
          aria-label={`Ate something else for ${label}`} className={dark.ghostLink}>Ate something else</button></>}
      </p>
    </div>
  </motion.div>;
}

/**
 * The card's action strip (cards v4): one 44 px row of three equal icon zones — eaten | swap |
 * details — on the card's own charcoal, told apart by tone (no pills, no hairlines between them), each
 * zone its whole third as the tap target. The same strip closes a card collapsed or open. An eaten or
 * fixed meal cannot swap: its third shows a plain dash at full contrast, never a faded icon. The
 * details control rotates open and shut; focus comes back to it, or to Swap when Swap opened a flow,
 * when a flow closes (`focusOnMount`, `returnTo`), since the control that opened the flow is gone.
 */
export function MealCardFooter({ label, expanded, controls, onToggle, onSwap, eatenControl, focusOnMount,
  returnTo = "toggle" }: {
  label: string; expanded: boolean; controls: string;
  onToggle: () => void;
  /** Open the swap flow; absent when the meal cannot be swapped. */
  onSwap?: () => void;
  /** The eaten zone (components/ui/MealNutritionDivider MealEatenButton). */
  eatenControl?: ReactNode;
  focusOnMount?: boolean;
  returnTo?: "swap" | "toggle";
}) {
  const toggleButton = useRef<HTMLButtonElement | null>(null);
  const swapButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const target = (returnTo === "swap" && swapButton.current) || toggleButton.current;
    // Only while focus is still lost (the page) or still in this card: a strip that comes back late,
    // after the user has moved on to another card's flow, never pulls focus away from it.
    const active = document.activeElement;
    const free = !active || active === document.body
      || (!!target && !!active.closest("[data-card-group]") && active.closest("[data-card-group]") === target.closest("[data-card-group]"));
    if (free) target?.focus({ preventScroll: true });
    // When a flow has just closed (the card turns `focusOnMount` on in the commit after it does).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOnMount]);
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggle();
  };
  return <div data-meal-actions="true" data-meal-strip="" className={dark.strip}>
    <div data-strip-zone="eaten" className={`${dark.zone} ${dark.zoneEaten}`}>{eatenControl}</div>
    <div data-strip-zone="swap" className={`${dark.zone} ${dark.zoneSwap}`}>
      {onSwap ? <button ref={swapButton} type="button" onClick={onSwap} aria-label={`Swap ${label}`}
        className={dark.zoneButton}><ArrowLeftRight aria-hidden="true" size={20} strokeWidth={1.8} /></button>
        : <span aria-hidden="true" data-swap-unavailable="" className={`${dark.zoneButton} ${dark.zoneIdle}`}>—</span>}
    </div>
    <div data-strip-zone="details" className={`${dark.zone} ${dark.zoneDetails}`}>
      <button ref={toggleButton} type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        aria-expanded={expanded} aria-controls={controls} onClick={toggle} className={dark.zoneButton}>
        <span className={dark.chevron} data-open={expanded ? "true" : undefined}><ChevronIcon size={20} /></span>
      </button>
    </div>
  </div>;
}

export function useMealDetail(slot: ResolvedSlot, onOpenEdit: (() => void) | undefined,
  dayTotals?: DayTotals, onAsk?: () => void, editor?: IngredientEditor, previewMacros?: Macros | null,
  onAteElse?: () => void, footerFocus = false,
  strip?: { eatenControl?: ReactNode; onSwap?: () => void; returnTo?: "swap" | "toggle" }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const toggle = () => {
    if (expanded) editor?.onPreview(null);
    setExpanded((open) => !open);
  };
  return {
    expanded,
    toggle,
    openEdit: () => onOpenEdit?.(),
    footer: <MealCardFooter label={slot.label} expanded={expanded} controls={id} onToggle={toggle}
      focusOnMount={footerFocus} eatenControl={strip?.eatenControl} onSwap={strip?.onSwap}
      returnTo={strip?.returnTo} />,
    detail: expanded ? <MealDetail key="detail" id={id} label={slot.label} components={slot.components}
      macros={previewMacros ?? slot.macros} dayTotals={dayTotals} prepMinutes={slot.meal?.prepMinutes}
      editor={editor} marked={slot} onAsk={onAsk} onAteElse={onAteElse}
      onSearch={editor ? undefined : onOpenEdit} /> : null,
    /** The slot's worst mark for the tray's top line (components/SlotRuleMarks.tsx). */
    ruleMark: slotRuleMark(slot, expanded),
  };
}
