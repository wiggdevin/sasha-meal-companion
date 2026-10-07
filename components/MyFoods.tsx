"use client";

import Disclosure from "@/components/ui/Disclosure";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import AddFoodSheet from "@/components/AddFoodSheet";
import FoodSheet from "@/components/FoodSheet";
import { foodToAvoid, ROLE_LABELS, type Food, type FoodRole } from "@/lib/foods";
import { kcalPer100Label } from "@/lib/foods/display";
import { roleFromName } from "@/lib/foods/role";
import {
  FOOD_MEMBERSHIP_SAVE_MESSAGE, FOOD_MEMBERSHIP_TRUNCATED_MESSAGE,
  FoodMembershipSaveError, FoodPartialSaveError, saveFoodEdits, setFoodMembership,
  type FoodEditFields,
} from "@/lib/foods/prefs-client";
import { loadStore, setFoodNote, setFoodStatus, upsertFood } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { accountHandle, assertCurrent, currentAccountOrNull, isCurrent, onAccountGone, onAccountReady } from "@/lib/device/account";
import { PRESS_SLOP_PX, swipeDismissDecision } from "@/lib/today/presentation";
import styles from "./MyFoods.module.css";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import CappedList, { ListFooter, type ListAdd } from "@/components/MyFoods.list";
import { useFoodFavorites } from "@/components/MyFoods.favorites";
import { useEatsRuleMarks } from "@/components/MyFoods.rule-marks";
import RuleMark from "@/components/ui/RuleMark";

const ROLES: FoodRole[] = ["protein", "carb", "fat"];

/* Fixed macro colours — DESIGN.md Colors, gauge tokens. Never re-assigned. */
const ROLE_DOT: Record<FoodRole, string> = {
  protein: "var(--color-gauge-protein)",
  carb: "var(--color-gauge-carbs)",
  fat: "var(--color-gauge-fat)",
};

/* Recipes copied from Foods.dc.html: section header and the glass list row. The Eats / Avoid
   toggle that used to sit here is now the page-level tablist (Segmented.tsx) — the account's foods are
   split across the two tabs, so this file has one component per tab. */
/** .section-title sets its own weight and tracking (unlayered), so the card-title values win with `!`. */
const SECTION_TITLE = "section-title m-0 text-title font-semibold! tracking-heading-sm!";
const SECTION_COUNT = "ground-muted text-tiny font-normal"; // colour from .ground-muted: it sits on the bare ground
const ROW_TITLE = "text-body font-medium";
const ROW_META = "text-tiny font-normal text-muted";
/** A category card's padding left and right of its rows; its footer row runs edge to edge. */
const CARD_INSET = "px-4";

function Dot({ role }: { role: FoodRole }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0"
      style={{ width: 10, height: 10, borderRadius: 9999, background: ROLE_DOT[role] }}
    />
  );
}

/** "165 kcal / 100 g" — the meta on the right of every row (lib/foods/display.ts). */
function meta(food: Food): string {
  return kcalPer100Label(food);
}

/* DESIGN.md Iconography: linear, currentColor, inline SVG. Filled olive when starred. */
function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9Z" />
    </svg>
  );
}

/**
 * The row's star: a 44 px button around a small glyph, `aria-pressed` for the state, one name in
 * both states ("Favorite Oats"), so a screen reader hears "Favorite Oats, toggle button, pressed".
 */
function StarToggle({ food, starred, onToggle, covered = false, className = "" }: {
  food: Food; starred: boolean; onToggle: () => void;
  /** Remove is open over it (swipe or Edit): out of reach for taps, the keyboard and assistive tech. */
  covered?: boolean;
  className?: string;
}) {
  // The empty star is the muted ink, not the faint icon tone, so the toggle reads at 3:1 or better
  // against the card (Kimi K3 audit 2026-10-04, finding 31).
  return (
    <button type="button" data-row-star aria-pressed={starred} onClick={onToggle}
      aria-label={`Favorite ${food.name.trim() || "this food"}`}
      aria-hidden={covered || undefined} tabIndex={covered ? -1 : undefined}
      className={`tap flex size-11 shrink-0 items-center justify-center rounded-full ${
        starred ? "text-primary" : "text-muted"} ${className}`.trim()}>
      <StarGlyph filled={starred} />
    </button>
  );
}

/** What a list needs to draw and toggle each row's star. */
type Stars = { isStarred: (food: Food) => boolean; toggle: (food: Food) => void };

/**
 * A row's swipe, FluidVoice A04: a partial left swipe reveals Remove, a full one removes. The
 * thresholds and the horizontal-dominance rule are Today's card swipe (lib/today/presentation.ts),
 * so a diagonal scroll, a short nudge or a rightward drag never writes.
 */
export function foodRowSwipeDecision(deltaX: number, deltaY: number): "reveal" | "remove" | null {
  const decision = swipeDismissDecision(deltaX, deltaY);
  return decision === "dismiss" ? "remove" : decision;
}

/** The revealed control's width (MyFoods.module.css); a drag starts here when the row is open. */
const REVEALED_PX = 72;
const REVEALED_WIDE_PX = 96;
/** How far a hidden Remove sits to the right of its place (MyFoods.module.css `.remove`). */
const REMOVE_OFFSET_PX = 12;

/**
 * Remove's look while a finger drags the row: it comes in from the right edge as the finger travels
 * the first `width` px, then widens to follow a full swipe. Pure, so the gesture is testable.
 */
export function removeDragStyle(pull: number, width: number): {
  opacity: number; transform: string; width: number; transition: "none";
} {
  const progress = Math.min(1, Math.max(0, pull) / width);
  return { opacity: progress, transform: `translate(${Math.round((1 - progress) * REMOVE_OFFSET_PX)}px, -50%)`,
    width: Math.max(width, Math.round(pull)), transition: "none" };
}

/**
 * The row action's visible text and name. Other foods are already neutral, so the same idempotent
 * operation only clears any mark left on a same-name ref; the row and its note stay. It says so.
 */
function removeCopy(food: Food): { text: string; label: string } {
  if (food.status === "avoid") return { text: "Remove", label: `Remove ${food.name} from Avoid` };
  if (food.status === "eats") return { text: "Remove", label: `Remove ${food.name} from Eats` };
  return { text: "Clear marks", label: `Clear marks for ${food.name}` };
}

function FoodRow({ food, last, editing, onOpen, onRemove, renderStatus, describe, stars }: { food: Food; last: boolean;
  editing: boolean; onOpen: () => void; onRemove?: () => void; renderStatus?: (food: Food) => ReactNode;
  /** The status line describes the row's Edit button (a rule mark says why the food is marked). */
  describe?: boolean; stars?: Stars }) {
  const avoid = food.status === "avoid";
  const [revealed, setRevealed] = useState(false);
  const [dragX, setDragX] = useState<number | null>(null);
  const swipe = useRef<{ x: number; y: number; moved: boolean; captured: boolean } | null>(null);
  const suppressClick = useRef(false);
  const neutral = food.status === "neutral";
  const width = neutral ? REVEALED_WIDE_PX : REVEALED_PX;
  const rest = revealed ? -width : 0;
  // A captured drag shows Remove coming in under the finger; the row's own content never moves.
  const open = revealed || editing || dragX !== null;
  const status = renderStatus?.(food);
  const hasStatus = status != null && status !== false;
  const statusId = useId();
  return (
    <div className={`min-w-0 border-b ${last ? "border-transparent" : "border-hairline"}`}>
    <div className={`flex min-w-0 items-center ${styles.row}`} data-food-row={food.id}
      data-open={onRemove && open ? "true" : "false"}
      style={{ touchAction: onRemove ? "pan-y" : undefined }}
      onPointerDown={(event) => {
        suppressClick.current = false;
        swipe.current = null;
        if (!onRemove || (event.pointerType === "mouse" && event.button !== 0)) return;
        // A press on Remove or the star belongs to it; the row's own edit button is the swipe surface.
        if (event.target instanceof Element && event.target.closest("[data-row-remove],[data-row-star]")) return;
        swipe.current = { x: event.clientX, y: event.clientY, moved: false, captured: false };
      }}
      onPointerMove={(event) => {
        const start = swipe.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > PRESS_SLOP_PX) start.moved = true;
        // A vertical drag is the page's scroll: it never moves the row or captures the pointer.
        if (!start.moved || Math.abs(dx) <= Math.abs(dy)) return;
        if (!start.captured) {
          start.captured = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        setDragX(Math.min(0, rest + dx));
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null;
        setDragX(null);
        if (!start?.moved) return;
        suppressClick.current = true;
        if (!start.captured) return;
        const decision = foodRowSwipeDecision(rest + event.clientX - start.x, event.clientY - start.y);
        setRevealed(decision === "reveal");
        if (decision === "remove") onRemove?.();
      }}
      onPointerCancel={() => { swipe.current = null; setDragX(null); }}
      onClickCapture={(event) => {
        // Only the pointer's own follow-up click is swallowed; a keyboard activation always lands.
        if (!suppressClick.current || event.detail === 0) { suppressClick.current = false; return; }
        suppressClick.current = false;
        event.stopPropagation();
      }}>
    {/* A tap on a swiped-open row closes it, as on iOS; the next tap opens the food. */}
    <button type="button" onClick={revealed && !editing ? () => setRevealed(false) : onOpen}
      aria-label={`Edit ${food.name}`} aria-describedby={describe && hasStatus ? statusId : undefined}
      className={`tap flex min-w-0 flex-1 items-center gap-3 px-2.5 py-3 text-left ${styles.face}`}>
      <Dot role={food.role} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate ${ROW_TITLE} ${avoid ? "line-through" : ""}`}>
          {food.name.trim() || "Unnamed food"}
        </span>
        {food.note && (
          <span className={`truncate italic ${ROW_META}`}>
            {food.note}
          </span>
        )}
      </span>
      <span className={`shrink-0 tabular-nums ${ROW_META} ${onRemove ? styles.covered : ""}`}>
        <KcalText text={meta(food)} />
      </span>
    </button>
    {stars && <StarToggle food={food} starred={stars.isStarred(food)} onToggle={() => stars.toggle(food)}
      covered={!!onRemove && (revealed || editing)} className={onRemove ? styles.covered : ""} />}
    {onRemove && <button type="button" data-row-remove data-revealed={revealed || editing ? "true" : "false"}
      onClick={() => { setRevealed(false); onRemove(); }}
      aria-label={removeCopy(food).label}
      className={`tap min-h-11 rounded-full text-tiny font-medium ${styles.remove} ${neutral ? styles.wide : ""}`}
      style={dragX === null ? undefined : removeDragStyle(-dragX, width)}>
      {removeCopy(food).text}
    </button>}
    </div>
    {hasStatus && <div id={statusId} className="px-2.5 pb-2">{status}</div>}
    </div>
  );
}

/**
 * A card's rows and its footer: the first six, then one footer row with "Show all N" opening the
 * rest in place on the left and the card's Add on the right (MyFoods.list.tsx, U14). An empty list
 * still ends in the same footer, Add alone.
 */
function FoodList({ list, title, editing = false, onOpen, onRemove, renderStatus, describe, stars, add }: { list: Food[];
  title: string; editing?: boolean; onOpen: (id: string) => void;
  onRemove?: (id: string) => void; renderStatus?: (food: Food) => ReactNode; describe?: boolean; stars?: Stars;
  add: ListAdd }) {
  if (list.length === 0) return <ListFooter add={add} />;
  return (
    <CappedList items={list} keyOf={(f) => f.id} divided label={title} add={add} inset={CARD_INSET}
      render={(f, { last }) => (
        <FoodRow food={f} last={last} editing={editing}
          onOpen={() => onOpen(f.id)}
          onRemove={onRemove ? () => onRemove(f.id) : undefined} renderStatus={renderStatus} describe={describe} stars={stars} />
      )} />
  );
}

/**
 * The visible, 44 px alternative to the swipe: pressed, it shows every row's Remove in one card.
 * Its name stays "Edit <list> list" in both states — aria-pressed carries the state — and the
 * hidden suffix tells each card's toggle apart for a screen reader.
 */
function EditToggle({ title, editing, onToggle }: { title: string; editing: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-pressed={editing} onClick={onToggle}
      className={`tap -my-2 min-h-11 shrink-0 rounded-full px-3 text-caption ${
        editing ? "chip-on" : "text-muted"}`}>
      Edit{" "}<span className="sr-only">{title} list</span>
    </button>
  );
}

/** The account's foods out of localStorage, kept in step with a pull from the server. */
function useFoodsStore() {
  const [foods, setFoods] = useState<Record<string, Food> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFoods(loadStore().foods);
    const onSynced = () => setFoods(loadStore().foods);
    window.addEventListener(SYNCED_EVENT, onSynced);
    const offGone = onAccountGone(() => setFoods(null));
    const offReady = onAccountReady(() => setFoods(loadStore().foods));
    return () => { window.removeEventListener(SYNCED_EVENT, onSynced); offGone(); offReady(); };
  }, []);

  return [foods, setFoods] as const;
}

/**
 * Every mutation site on this screen goes through here. `lib/store.ts` stays synchronous and pure,
 * so the server half of a mark — the normalized-name membership op the coach, search, the scanner
 * and the log commit all read — is emitted beside the local write rather than inside it. Fire-and-forget:
 * the op queues in the outbox, and offline leaves the food uncached for the next backfill run.
 *
 * It returns the same map it was given, so a call site stays one expression.
 */
function saved(
  foods: Record<string, Food>, id: string, setError: (message: string | null) => void,
  onAcknowledged?: (food: Food) => void,
): Record<string, Food> {
  const food = foods[id];
  if (food) {
    const h = currentAccountOrNull();
    setError(null);
    void setFoodMembership(
      food.name,
      food.status === "neutral" ? null : food.status,
      { acknowledge: true, food, note: null },
    ).then((result) => {
      if (h && !isCurrent(h)) return;
      if (result) onAcknowledged?.(food);
      const notice = foodMembershipNotice(result);
      if (notice) setError(notice);
    }).catch((error: unknown) => { if (!h || isCurrent(h)) setError(foodMembershipError(error)); });
  }
  return foods;
}

function projectFoodEdit(current: Food, note: string, role: FoodRole,
  perUnit: Food["perUnit"], fields: FoodEditFields): Food {
  return { ...current,
    note: fields.note ? note.trim() || undefined : current.note,
    role: fields.role ? role : current.role,
    perUnit: fields.nutrition ? perUnit : current.perUnit };
}

function SaveError({ message }: { message: string | null }) {
  return message ? <Notice tone="error" title={message} className="px-1.5" /> : null;
}

export function foodMembershipNotice(result: { truncated: boolean } | null): string | null {
  return result?.truncated ? FOOD_MEMBERSHIP_TRUNCATED_MESSAGE : null;
}

export function foodMembershipError(error: unknown): string {
  return error instanceof FoodMembershipSaveError || error instanceof FoodPartialSaveError
    ? error.message : FOOD_MEMBERSHIP_SAVE_MESSAGE;
}

/** What a membership write did, in the words its confirmation uses. */
function membershipCopy(food: Food, next: Food["status"]): string {
  if (next === "avoid") return `${food.name} moved to Avoid.`;
  if (next === "eats") return `${food.name} added to Eats.`;
  if (food.status === "neutral") return `Marks cleared for ${food.name}.`;
  return `${food.name} removed from ${food.status === "avoid" ? "Avoid" : "Eats"}.`;
}

/**
 * Eats membership writes through the shared ActionFeedback (FluidVoice F01-F09): the row moves at
 * once, the durable normalized-name op follows, a failure rolls the row back with the shared alert,
 * and Undo restores the earlier membership. Clearing an already-neutral row has nothing to restore,
 * so it offers no Undo; it stays idempotent and keeps the row and its note. Writes queue, never join.
 */
function useMembershipChange(setFoods: (foods: Record<string, Food>) => void,
  setSaveError: (message: string | null) => void) {
  const feedback = useActionFeedback();
  /** Per food, the newest move this screen made: only the newest may be rolled back. */
  const latest = useRef(new Map<string, number>());
  function change(id: string, next: Food["status"]): void {
    const previous = loadStore().foods[id];
    if (!previous) return;
    const seq = (latest.current.get(id) ?? 0) + 1;
    latest.current.set(id, seq);
    const h = accountHandle();
    const moved = setFoodStatus(id, next).foods[id];
    setFoods(loadStore().foods);
    setSaveError(null);
    void feedback.run(async () => {
      const result = await setFoodMembership(moved.name, next === "neutral" ? null : next,
        { acknowledge: true, food: moved, note: null, account: h });
      const notice = foodMembershipNotice(result);
      if (notice && isCurrent(h)) setSaveError(notice);
      return result;
    // The row's Remove (or the sheet) is gone by the time the write lands, so the confirmation
    // needs the notice even when there is nothing to undo (a neutral row's Clear marks).
    }, { kind: "change", queue: true, confirm: "notice", stale: () => !isCurrent(h),
      successMessage: membershipCopy(previous, next),
      failureMessage: foodMembershipError,
      undo: previous.status === next ? undefined
        : { action: () => { if (isCurrent(h)) change(id, previous.status); } },
    }).then((outcome) => {
      // A failed move is undone locally only while it is still the newest move of that food.
      if (!outcome.ok && isCurrent(h) && latest.current.get(id) === seq) {
        setFoods(upsertFood({ ...loadStore().foods[id], status: previous.status }).foods);
      }
    });
  }
  return { change, feedback };
}

function byName(a: Food, b: Food): number {
  return a.name.localeCompare(b.name);
}

function count(n: number): string {
  return `${n} ${n === 1 ? "food" : "foods"}`;
}

/**
 * The section header every group here shares: a 20 px title, a count on the right. `as` is the
 * heading level, not a size — "Can't eat right now" is a peer of the Avoids rule cards (h2),
 * while Protein / Carbs / Fats are groups inside "My foods" (h3).
 */
function GroupHeader({ title, n, as: Heading = "h3", action }: {
  title: string; n: number; as?: "h2" | "h3"; action?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1.5">
      <Heading className={SECTION_TITLE}>
        {title}
      </Heading>
      <span className="flex items-baseline gap-1">
        <span className={SECTION_COUNT}>{count(n)}</span>
        {action}
      </span>
    </div>
  );
}

/** What a list looks like before localStorage has been read. */
function ListSkeleton() {
  return <div className="h-40 rounded-[32px] bg-fog" />;
}

/**
 * The Eats list. Grouped glass lists — one group per macro role, a role dot on every row.
 * Every meal in the app is built from this list — take one out here and it is out everywhere.
 */
export default function EatsFoods() {
  const [foods, setFoods] = useFoodsStore();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingRole, setAddingRole] = useState<FoodRole | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const membership = useMembershipChange(setFoods, setSaveError);
  const favorites = useFoodFavorites();
  const stars: Stars = { isStarred: favorites.isStarred, toggle: (food) => { void favorites.toggle(food); } };
  // Why a food on Eats is not being suggested, from the server's verified set; never hides the row.
  const ruleMarks = useEatsRuleMarks(foods);
  const renderRuleMark = (food: Food) => {
    const mark = ruleMarks.markFor(food);
    return mark ? <RuleMark mark={mark} /> : null;
  };

  useEffect(() => onAccountGone(() => {
    setOpen(null); setAdding(false); setSaveError(null); setEditing(null);
  }), []);

  if (!foods) {
    return <ListSkeleton />;
  }

  const all = Object.values(foods);
  const eats = (role: FoodRole) =>
    all.filter((f) => f.status === "eats" && f.role === role).sort(byName);
  const other = all.filter((f) => f.status === "neutral").sort(byName);
  const openFood = open ? foods[open] : null;
  // The one removal path for a role group and Other alike: the durable neutral-membership op.
  // Notes stay on the food; nothing is deleted.
  const remove = (id: string) => membership.change(id, "neutral");

  return (
    <MotionConfig reducedMotion="user">
      <section className="flex flex-col gap-5">
        <SaveError message={saveError} />
        <SaveError message={favorites.error} />
        {/* Rows that would look cleared without a check: one quiet line, never a row each. */}
        {ruleMarks.notice && <Notice tone={ruleMarks.notice.tone} title={ruleMarks.notice.title}
          className="px-1.5" />}

        {ROLES.map((role) => {
          const list = eats(role);
          const title = ROLE_LABELS[role];
          return (
            <div key={role} className="shell">
              <div className="surface flex flex-col">
                <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
                  <GroupHeader title={title} n={list.length} action={list.length > 0 && <EditToggle
                    title={title} editing={editing === role}
                    onToggle={() => setEditing((current) => current === role ? null : role)} />} />
                  {list.length === 0 && (
                    <p className="m-0 px-1.5 pb-2 text-caption text-muted">None right now. Add one below.</p>
                  )}
                </div>
                <FoodList list={list} title={`${title} foods`} editing={editing === role} onOpen={setOpen}
                  onRemove={remove} stars={stars} renderStatus={renderRuleMark} describe
                  add={{ label: `Add ${title.toLowerCase()} food`,
                    onAdd: () => { setAddingRole(role); setAdding(true); } }} />
              </div>
            </div>
          );
        })}

        <Disclosure title="Other foods" count={count(other.length)} bodyClassName="flex flex-col gap-2">
          {other.length === 0 ? (
            <p className={`m-0 ${CARD_INSET} pb-2 text-caption text-muted`}>Nothing here.</p>
          ) : (
            <div className={`flex justify-end ${CARD_INSET}`}>
              <EditToggle title="Other foods" editing={editing === "other"}
                onToggle={() => setEditing((current) => current === "other" ? null : "other")} />
            </div>
          )}
          <FoodList list={other} title="other foods" editing={editing === "other"} onOpen={setOpen}
            onRemove={remove} stars={stars} add={{ label: "Add another food",
              onAdd: () => { setAddingRole(null); setAdding(true); } }} />
        </Disclosure>
      </section>
      <ActionFeedbackToast notice={membership.feedback.notice} onDismiss={membership.feedback.dismiss} />

      <AnimatePresence>
        {openFood && (
          <FoodSheet
            key={openFood.id}
            food={openFood}
            onSetStatus={(status) => {
              membership.change(openFood.id, status);
              setOpen(null);
            }}
            onSetNote={(note) => setFoods(saved(
              setFoodNote(openFood.id, note).foods, openFood.id, setSaveError,
            ))}
            onSave={async ({ note, role, perUnit }) => {
              const h = accountHandle();
              try {
                const result = await saveFoodEdits(openFood, note, role, perUnit);
                assertCurrent(h);
                const current = loadStore().foods[openFood.id] ?? openFood;
                setFoods(upsertFood(projectFoodEdit(current, note, role, perUnit,
                  { note: true, role: true, nutrition: true })).foods);
                return result;
              } catch (cause) {
                if (cause instanceof FoodPartialSaveError && isCurrent(h)) {
                  const current = loadStore().foods[openFood.id] ?? openFood;
                  setFoods(upsertFood(projectFoodEdit(current, note, role, perUnit, cause.saved)).foods);
                }
                throw cause;
              }
            }}
            onClose={() => setOpen(null)}
          />
        )}
        {adding && (
          <AddFoodSheet
            key="add"
            existing={foods}
            initialRole={addingRole ?? undefined}
            onAdd={(food) => {
              // The group's Add places a food in that group unless its name settles the group
              // itself: "Chicken breast" added from the Carbs card is still a protein.
              const placed = addingRole && !roleFromName(food.name) ? { ...food, role: addingRole } : food;
              const h = accountHandle();
              setFoods(upsertFood(placed).foods);
              setSaveError(null);
              void saveFoodEdits(placed, placed.note ?? "", placed.role, placed.perUnit,
                { ensureMembership: true }).then((result) => {
                if (!isCurrent(h)) return;
                const notice = foodMembershipNotice(result.membership);
                if (notice) setSaveError(notice);
              }).catch((error: unknown) => { if (isCurrent(h)) setSaveError(foodMembershipError(error)); });
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

/**
 * The Avoids list: the foods that hurt, with the note that says why. Nothing is deleted, so
 * a row here is one tap from coming back. Adding straight to Avoid is the one-step version of
 * "raw onion — hurt on 9/12" after a flare.
 *
 * The header renders before the store does: the count is the only part of this that waits.
 */
export function AvoidFoods({ renderAvoidStatus, onAvoidSaved }: {
  renderAvoidStatus?: (food: Food) => ReactNode;
  onAvoidSaved?: (food: Food) => void;
} = {}) {
  const [foods, setFoods] = useFoodsStore();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const removalFeedback = useActionFeedback();

  useEffect(() => onAccountGone(() => {
    setOpen(null); setAdding(false); setSaveError(null); setEditing(false);
  }), []);

  const avoid = foods
    ? Object.values(foods).filter((f) => f.status === "avoid").sort(byName)
    : [];
  const openFood = open && foods ? foods[open] : null;

  function removeAvoid(id: string) {
    if (!foods || removalFeedback.phase === "pending") return;
    const previous = foods[id];
    if (!previous) return;
    const h = accountHandle();
    const removed = setFoodStatus(id, "neutral").foods[id];
    setFoods(loadStore().foods);
    void removalFeedback.run(async () => {
      const result = await setFoodMembership(removed.name, null,
        { acknowledge: true, food: removed, note: null, account: h });
      if (result && isCurrent(h)) onAvoidSaved?.(removed);
      return result;
    }, { kind: "change", successMessage: `${previous.name} removed from Avoid.`,
      undo: { action: () => {
        if (!isCurrent(h)) return;
        setFoods(saved(setFoodStatus(id, "avoid").foods, id, setSaveError, onAvoidSaved));
      } },
    }).then((outcome) => {
      if (!outcome.ok && isCurrent(h)) setFoods(upsertFood(previous).foods);
    });
  }

  return (
    <MotionConfig reducedMotion="user">
      <section className="flex flex-col gap-3">
        <SaveError message={saveError} />
        {/* Until the store is read, an empty list and an empty store look the same. Say neither. */}
        {!foods ? (
          <ListSkeleton />
        ) : (
          <div className="shell"><div className="surface flex flex-col">
            <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
              <GroupHeader title="Can't eat right now" n={avoid.length} as="h2"
                action={avoid.length > 0 && <EditToggle title="Avoid" editing={editing}
                  onToggle={() => setEditing((value) => !value)} />} />
              {avoid.length === 0 && (
                <p className="m-0 px-1.5 pb-2 text-caption text-muted">
                  Nothing here. Add one below, or move a food here from Eats.
                </p>
              )}
            </div>
            <FoodList list={avoid} title="foods to avoid" editing={editing} onOpen={setOpen}
              renderStatus={renderAvoidStatus} onRemove={removeAvoid}
              add={{ label: "Add a food to avoid", onAdd: () => setAdding(true) }} />
          </div></div>
        )}
      </section>
      <ActionFeedbackToast notice={removalFeedback.notice} onDismiss={removalFeedback.dismiss} />

      <AnimatePresence>
        {openFood && (
          <FoodSheet
            key={openFood.id}
            food={openFood}
            onSetStatus={(status) => {
              setFoods(saved(setFoodStatus(openFood.id, status).foods, openFood.id,
                setSaveError, onAvoidSaved));
              setOpen(null);
            }}
            onSetNote={(note) => setFoods(saved(
              setFoodNote(openFood.id, note).foods, openFood.id, setSaveError,
            ))}
            onSave={async ({ note, role, perUnit }) => {
              const h = accountHandle();
              try {
                const result = await saveFoodEdits(openFood, note, role, perUnit);
                assertCurrent(h);
                const current = loadStore().foods[openFood.id] ?? openFood;
                const edited = projectFoodEdit(current, note, role, perUnit,
                  { note: true, role: true, nutrition: true });
                setFoods(upsertFood(edited).foods);
                return result;
              } catch (cause) {
                if (cause instanceof FoodPartialSaveError && isCurrent(h)) {
                  const current = loadStore().foods[openFood.id] ?? openFood;
                  setFoods(upsertFood(projectFoodEdit(current, note, role, perUnit, cause.saved)).foods);
                }
                throw cause;
              }
            }}
            onClose={() => setOpen(null)}
          />
        )}
        {adding && foods && (
          <AddFoodSheet
            key="add"
            existing={foods}
            targetStatus="avoid"
            onAdd={(food) => {
              const avoided = foodToAvoid(food);
              const h = accountHandle();
              setFoods(upsertFood(avoided).foods);
              setSaveError(null);
              void saveFoodEdits(avoided, avoided.note ?? "", avoided.role, avoided.perUnit,
                { ensureMembership: true }).then((result) => {
                if (!isCurrent(h)) return;
                onAvoidSaved?.(avoided);
                const notice = foodMembershipNotice(result.membership);
                if (notice) setSaveError(notice);
              }).catch((error: unknown) => { if (isCurrent(h)) setSaveError(foodMembershipError(error)); });
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
