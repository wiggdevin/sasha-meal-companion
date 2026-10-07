"use client";

import { useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { formatMacro } from "@/components/nutrition/spec";
import { applyAvoidOffer, noteSuggestsAvoid, ROLE_LABELS, UNIT_LABELS, type Food } from "@/lib/foods";
import { kcalPer100Label, per100Base } from "@/lib/foods/display";
import { getFoodDetail } from "@/lib/catalog-client";
import { loadConstraints } from "@/lib/constraints-client";
import { currentAccountOrNull } from "@/lib/device/account";
import { currentRevisionAndIdentityFor, type ProductIdentity } from "@/lib/foods/food-revision-client";
import { markFoodLabelChecked } from "@/lib/foods/label-check-client";
import { readPrefRefCache } from "@/lib/foods/prefs-client";
import { HELD_ALLERGEN_TEXT } from "@/lib/policy/allergen-holds";
import { allergenKey, CROSS_CONTACT_NOTE } from "@/lib/policy/allergens";
import { ruleLabel } from "@/lib/reference";
import Button from "@/components/ui/Button";
import GlassSelect from "@/components/ui/GlassSelect";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import { canEditFoodNutrients, verifyFoodNutrientsEditable } from "@/lib/foods/prefs-client";
import type { FoodEditResult } from "@/lib/foods/prefs-client";

/* Buttons are `components/ui/Button` (2026-10-04): the olive primary brings a food back from Avoid,
   the secondary moves it on; both are the 52 px sheet size. */

const LABEL = "text-tiny font-normal text-graphite";
const CAPTION = "text-tiny font-normal leading-body-sm text-muted";

/* The one-tap offer a bad note earns. Same glass grey as the sheet's close
   button; its class carries the 44 px target. */
const OFFER: React.CSSProperties = { borderRadius: 12, background: "rgba(0,0,0,0.05)" };
const OFFER_CLASS = "text-charcoal text-caption font-normal text-left";

type Setters = {
  onSetStatus: (status: Food["status"]) => void;
  onSetNote: (note: string) => void;
};

export function foodSheetAction(status: Food["status"]): {
  next: Food["status"];
  label: string;
} {
  if (status === "avoid") return { next: "neutral", label: "Remove from Avoid" };
  if (status === "neutral") return { next: "eats", label: "Add to Eats" };
  return { next: "avoid", label: "Add to Avoid" };
}

/** The footer: one button that applies the next membership action, saving the note first. */
function StatusButton({ status, note, onSetStatus, onSetNote, disabled }: Setters & {
  status: Food["status"]; note: string; disabled?: boolean;
}) {
  const avoid = status === "avoid";
  const action = foodSheetAction(status);
  return (
    <Button variant={avoid ? "primary" : "secondary"} size="lg" block disabled={disabled}
      onClick={() => {
        onSetNote(note);
        onSetStatus(action.next);
      }}>
      {action.label}
    </Button>
  );
}

/** The one-tap offer a bad note earns (F-03): Avoid, with the note kept. */
function AvoidOffer({ food, note, onSetStatus, onSetNote, disabled }: Setters & {
  food: Food; note: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        const moved = applyAvoidOffer({ ...food, note });
        onSetNote(moved.note ?? "");
        onSetStatus(moved.status);
      }}
      className={`tap w-full px-4 ${OFFER_CLASS}`}
      style={OFFER}
    >
      Sounds like this one hurt. Move to Avoid?
    </button>
  );
}

/** A stored per-unit macro as the edit field shows it: scaled, and free of float noise. */
function fieldValue(perUnit: number, scale: number): string {
  return scale === 1 ? String(perUnit) : String(Math.round(perUnit * scale * 100) / 100);
}

/**
 * One food. The numbers, a note, and one button that moves it between
 * Eats and Avoid. Nothing is ever deleted — colitis is a guessing game and
 * "hurt on 9/12" is worth keeping.
 */
export default function FoodSheet({ food, onSetStatus, onSetNote, onSave, onClose }: Setters & {
  food: Food;
  onSave?: (changes: { note: string; role: Food["role"]; perUnit: Food["perUnit"] }) => Promise<FoodEditResult>;
  onClose: () => void;
}) {
  const [note, setNote] = useState(food.note ?? "");
  const [role, setRole] = useState(food.role);
  // A food stored per gram (or ml) is read and edited per 100, the label's own basis.
  const fieldScale = food.unit === "g" || food.unit === "ml" ? 100 : 1;
  const fieldLabel = fieldScale === 100 ? `100 ${UNIT_LABELS[food.unit]}` : `1 ${UNIT_LABELS[food.unit]}`;
  const initialMacros = {
    protein: fieldValue(food.perUnit.protein, fieldScale), carbs: fieldValue(food.perUnit.carbs, fieldScale),
    fat: fieldValue(food.perUnit.fat, fieldScale),
  };
  const [macros, setMacros] = useState<Record<keyof Food["perUnit"], string>>(initialMacros);
  const feedback = useActionFeedback();
  const saving = feedback.phase === "pending";
  const [nutritionEditable, setNutritionEditable] = useState(false);
  const [savedDraft, setSavedDraft] = useState({ note: food.note ?? "", role: food.role,
    macros: initialMacros });
  const base = per100Base(food);
  const avoid = food.status === "avoid";
  const offer = !avoid && noteSuggestsAvoid(note);
  const setters = { onSetStatus, onSetNote };
  // An untouched field sends the stored value itself, so a note-only save never reads as a
  // nutrition edit through the per-100 rounding.
  const field = (key: keyof Food["perUnit"]) => macros[key] === initialMacros[key]
    ? food.perUnit[key] : Number(macros[key]) / fieldScale;
  const perUnit = { protein: field("protein"), carbs: field("carbs"), fat: field("fat") };
  const validMacros = Object.values(macros).every((raw) => raw.trim() !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0);
  const dirty = note !== savedDraft.note || role !== savedDraft.role ||
    (Object.keys(macros) as (keyof typeof macros)[]).some((key) => macros[key] !== savedDraft.macros[key]);

  useEffect(() => {
    let live = true;
    if (canEditFoodNutrients(food)) {
      void verifyFoodNutrientsEditable(food).then((allowed) => {
        if (live) setNutritionEditable(allowed);
      }).catch(() => { if (live) setNutritionEditable(false); });
    }
    return () => { live = false; };
  }, [food]);

  return (
    <Sheet
      title={food.name}
      subtitle={`${ROLE_LABELS[food.role]} · ${kcalPer100Label(food)} · ${formatMacro(food.perUnit.protein * base.factor)}g protein · ${
        formatMacro(food.perUnit.carbs * base.factor)}g carbs · ${formatMacro(food.perUnit.fat * base.factor)}g fat`}
      onClose={onClose}
      footer={<div className="flex flex-col gap-2">
        <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
        {/* The save's words depend on the answer ("Saved — syncing."), so it confirms in the notice
            above rather than in the button. */}
        {onSave && <Button variant="primary" size="lg" block aria-busy={feedback.controlProps["aria-busy"]}
          className={feedback.controlProps.className}
          disabled={saving || !validMacros || !dirty} onClick={() => {
            const draft = { note, role, macros };
            // The shared feedback owns pending, the success glow and haptic, and the failure alert;
            // the words of a success depend on the answer, so they follow it.
            void feedback.run(() => onSave({ note, role, perUnit }), { kind: "commit",
              failureMessage: (cause) => cause instanceof Error ? cause.message : "Could not save changes. Try again.",
            }).then((outcome) => {
              if (!outcome.ok) return;
              setSavedDraft(draft);
              feedback.notify({ tone: "success", message: outcome.value.syncing ? "Saved — syncing." : "Changes saved." });
            });
          }}>{saving ? "Saving…" : "Save changes"}</Button>}
        <StatusButton status={food.status} note={note} disabled={saving || dirty} {...setters} />
      </div>}
    >
      <div className="flex flex-col gap-2 px-0.5">
        <span className={LABEL}>Food group</span>
        <GlassSelect aria-label="Food group" value={role} disabled={food.status === "neutral"}
          onChange={(next) => setRole(next as Food["role"])}
          options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))} />
        {food.status === "neutral" && <span className={CAPTION}>Add this food to Eats to change its group.</span>}
      </div>
      {nutritionEditable && <fieldset className="grid grid-cols-3 gap-2 border-0 p-0">
        <legend className={`mb-1 ${LABEL}`}>Nutrition per {fieldLabel}</legend>
        {(["protein", "carbs", "fat"] as const).map((key) => <label key={key} className="min-w-0 text-xs">
          {key === "carbs" ? "Carbs g" : `${key[0].toUpperCase()}${key.slice(1)} g`}
          <input type="number" inputMode="decimal" min="0" step="any" className="well mt-1 min-h-11 w-full min-w-0 px-2"
            value={macros[key]} onChange={(event) => setMacros((current) => ({ ...current, [key]: event.target.value }))} />
        </label>)}
      </fieldset>}
      <label className="flex flex-col gap-2 px-0.5">
        <span className={LABEL}>
          Note to self
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="e.g. fine plain, bad with oil · hurt on 9/12"
          className="well w-full resize-none px-4 py-3 text-body font-medium text-charcoal"
        />
      </label>
      {dirty && <p className={`m-0 ${CAPTION}`}>Save changes before moving this food.</p>}
      {offer && <AvoidOffer food={food} note={note} disabled={saving || dirty} {...setters} />}
      <LabelCheck food={food} />
      <p className={`m-0 px-0.5 pt-3 ${CAPTION}`}>
        {avoid
          ? "This food is off the menu. No meal will include it until you bring it back."
          : food.status === "neutral"
            ? "This food is saved, but it is not on Eats or Avoid and will not appear in meals."
          : "Moving it to Avoid takes it out of every meal at once. You can bring it back any time."}
      </p>
    </Sheet>
  );
}

/**
 * Phase 13 §9 R1: an allergen rule makes a food "Check the label" until its label says otherwise.
 * This lets the user mark the exact product checked for every allergen the account avoids. It never
 * says "safe": it records that they read the label, and says labels need not warn about
 * cross-contact.
 */
export function LabelCheck({ food }: { food: Food }) {
  const [allergens, setAllergens] = useState<string[]>([]);
  // W2a: allergen keys held for review on this food's revision (lib/policy/allergen-holds.ts) —
  // the user's check can never clear one. Stays [] for a food with no catalog detail to read
  // (e.g. a self-added food with no `catalogFoodId`), or a cached/offline detail from before this
  // field existed: the same "missing means none" contract `FoodDetail.heldAllergens` documents.
  const [heldAllergens, setHeldAllergens] = useState<string[]>([]);
  const [expectedRevisions, setExpectedRevisions] = useState<Record<string, number>>({});
  // A ref, not state: `mark()` only ever reads this at tap time and it must never itself trigger
  // a render, so setting it inside the effect below is not the setState-in-effect React warns
  // about — it is the frozen value the effect resolved once, not derived render output.
  const foodRefIdRef = useRef<string | null>(null);
  // ORCHESTRATOR fix (round 7, item 2): the button stays disabled until the ref and its expected
  // revision (bound together, below) have finished resolving — an early tap before then must not
  // send a request that carries no expectation at all, the one shape markLabelChecked accepts
  // unconditionally.
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "done" | "unavailable">("idle");
  // BLOCK (review round 1, phase 13 slice 2): the account has no way to confirm the resolved ref
  // is the product they actually inspected unless this resolves — this sheet shows only
  // `food.name` otherwise (the account's own saved label for the row, which can predate a
  // remapped ref or simply read differently than the catalog's own description/brand). §9 R1
  // marks the EXACT product as checked, so a ref whose identity this sheet could never confirm
  // must not ready the button either — the same "a failed lookup must never permit an unbound
  // check" rule finding #3 below already gives the revision lookup, extended to identity.
  const [identity, setIdentity] = useState<ProductIdentity | null>(null);
  useEffect(() => {
    let live = true;
    void loadConstraints().then((loaded) => {
      if (live && loaded) setAllergens(loaded.profile.avoid_allergens);
    });
    // sol BLOCK (review round 2): bind the mark to the revision this sheet resolves to RIGHT NOW
    // — the closest thing to "the one the user inspected" this flow has, unlike the barcode card
    // (which already binds its own displayed revision) — so the server skips a stale mark instead
    // of accepting whatever is active whenever the request happens to arrive.
    //
    // ORCHESTRATOR fix (round 7, item 2): the ref itself is bound here too, once, alongside its
    // expected revision — never re-read from the cache at tap time. A background mapping change
    // between the sheet opening and the tap (the cache now pointing at a different ref) must not
    // silently swap which product the check applies to: `mark()` below sends exactly this ref and
    // this expectation, unchanged.
    const userId = currentAccountOrNull()?.userId;
    const refs = userId ? readPrefRefCache(userId)[food.id] : undefined;
    const ref = refs?.catalogRefId ?? refs?.userRefId ?? null;
    foodRefIdRef.current = ref;
    // W2a: read this food's held allergen keys off its catalog detail, when it has one. A read
    // failure (offline, no account bound, not a catalog food) leaves `heldAllergens` at [], the
    // same posture as a cached detail that predates the field — never a reason to block the check.
    if (userId && food.catalogFoodId !== undefined) {
      void getFoodDetail(food.catalogFoodId).then((result) => {
        if (live && result.kind === "ok") setHeldAllergens(result.detail.heldAllergens ?? []);
      }).catch(() => {});
    }
    // One async flow either way (a real lookup, or an already-resolved `null`) so `setReady`
    // always runs from a promise callback, never synchronously in the effect body.
    //
    // sol BLOCK (review round 1, finding #3): a ref that resolved but whose revision lookup came
    // back `null` — a transient read failure, `currentRevisionAndIdentityFor` cannot tell that
    // apart from a genuinely dangling ref — must never enable the button. Enabling it sent an empty
    // `expectedRevisions` map, and markLabelChecked accepts an unmatched ref unconditionally
    // (no expectation to compare means no mismatch), marking whatever revision happens to be
    // active on arrival as checked though this sheet never actually resolved it. Only a ref that
    // resolved a real revision, or no ref at all (markFoodLabelChecked short-circuits to
    // "unavailable" on its own for that case), may ready the button.
    //
    // BLOCK (review round 1, phase 13 slice 2): the identity lookup now runs alongside the
    // revision lookup, in the SAME gate — the button used to ready off the revision alone, so a
    // ref whose identity never resolved (a transient read failure, or a remap) could still be
    // marked checked while this card showed no product for the account to compare against their
    // label. `ready` requires both to resolve for a bound ref: revision AND identity.
    //
    // sol BLOCK (review round 2): the revision and identity now come from ONE read
    // (`currentRevisionAndIdentityFor`), not two raced together by this Promise.all — two separate
    // round trips could each read a different row when a background remap landed between them,
    // showing the account the NEW product's name while binding the check to the OLD revision, a
    // mismatch the server's own `expectedRevisions` check cannot see (lib/foods/food-revision-
    // client.ts's own header has the full argument).
    void (ref ? currentRevisionAndIdentityFor(ref) : Promise.resolve(null)).then((found) => {
      if (!live) return;
      if (ref && found === null) return;
      if (ref && found) {
        setExpectedRevisions({ [ref]: found.revisionId });
        setIdentity(found.identity);
      }
      setReady(true);
    });
    return () => { live = false; };
  }, [food.id, food.catalogFoodId]);
  if (allergens.length === 0 || food.status === "avoid") return null;
  // W2a: a hold outranks the user's check (lib/policy/allergens.ts allergenFinding), so the
  // button never offers to cover a held key — only the ones a check can still settle.
  const held = new Set(heldAllergens.map(allergenKey));
  const heldKeys = allergens.filter((key) => held.has(allergenKey(key)));
  const checkableKeys = allergens.filter((key) => !held.has(allergenKey(key)));
  const names = checkableKeys.map((key) => ruleLabel(key).toLowerCase()).join(", ");
  const mark = async () => {
    setState("saving");
    // round 10 finding #2: bind the check to the allergen keys resolved when the sheet opened —
    // the same `allergens` this card already used to build its copy — not whatever the account's
    // profile has grown to by the time the request arrives. W2a: never a held key — the check
    // cannot settle it either way.
    const covered = await markFoodLabelChecked(food.id, true,
      { allergenKeys: checkableKeys, expectedRevisions, foodRefId: foodRefIdRef.current });
    setState(covered && covered.length > 0 ? "done" : "unavailable");
  };
  return (
    <div className="flex flex-col gap-2">
      <span className={LABEL}>Label check</span>
      {identity && (
        <p className={`m-0 ${CAPTION}`}>
          {identity.brand ? `${identity.description} · ${identity.brand}` : identity.description}
        </p>
      )}
      {heldKeys.length > 0 && (
        <div className="flex flex-col gap-1">
          {heldKeys.map((key) => (
            <p key={key} role="status" className={`m-0 ${CAPTION}`}>
              {`${ruleLabel(key)}: ${HELD_ALLERGEN_TEXT}`}
            </p>
          ))}
        </div>
      )}
      {checkableKeys.length > 0 && (state === "done" ? (
        <p role="status" className={`m-0 ${CAPTION}`}>
          {`You checked this label for ${names}. ${CROSS_CONTACT_NOTE}`}
        </p>
      ) : (
        <>
          <p className={`m-0 ${CAPTION}`}>
            {`Read this product's ingredient list for ${names}? Mark it checked to record that you `
              + "read it. A food already confirmed to contain one of them stays blocked either way."}
          </p>
          <button type="button" onClick={mark} disabled={state === "saving" || !ready}
            className={`tap h-11 self-start px-3 ${OFFER_CLASS}`} style={OFFER}>
            {state === "saving" ? "Saving" : "I checked the label"}
          </button>
          {state === "unavailable" && (
            <p role="status" className={`m-0 ${CAPTION}`}>
              This food is not saved to your account yet. Try again in a moment.
            </p>
          )}
        </>
      ))}
    </div>
  );
}
