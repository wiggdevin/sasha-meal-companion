"use client";

import { useEffect, useRef, useState } from "react";
import Sheet, { Pill } from "@/components/Sheet";
import { addCatalogFood } from "@/components/add-food/catalog-food";
import { SourceTag } from "@/components/CatalogSearch";
import AutoHeight from "@/components/add-food/AutoHeight";
import Button from "@/components/ui/Button";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import WorkingLine from "@/components/WorkingLine";
import SearchField from "@/components/ui/SearchField";
import { PlusIcon } from "@/components/ui/icons";
import { createSearchController, toRows, type CatalogRow } from "@/lib/catalog-client";
import { rowServingLine } from "@/lib/catalog/serving";
import { accountHandle, assertCurrent, currentAccountOrNull, isCurrent, type AccountHandle } from "@/lib/device/account";
import { dbFood } from "@/lib/food-db";
import { adoptBundledFood, bundledFoodUserId } from "@/lib/foods/adopt-client";
import { inferFoodRole } from "@/lib/foods/role";
import {
  bannedReason,
  ROLE_LABELS,
  slugify,
  UNIT_LABELS,
  type Food,
  type FoodRole,
  type FoodUnit,
} from "@/lib/foods";

const UNITS: FoodUnit[] = ["oz", "cup", "tbsp", "whole", "pouch", "can", "g"];

/* The sheet's rows sit on one tray inside the sheet, split by hairlines (E0: a sheet is already
   lifted, so nothing inside it casts its own shadow — DESIGN.md §Elevation). */
const TRAY = "overflow-hidden rounded-2xl bg-field elev-0";

const ROW_TITLE = "text-caption font-normal";
const ROW_META = "text-tiny font-normal text-muted";
const SECTION_LABEL = "text-tiny font-normal text-graphite";
const FIELD = "text-body font-medium text-charcoal";
const ALERT = "text-tiny font-normal text-alert";

/**
 * Add a food. Catalog results are one tap; anything else is a
 * name, a role, a unit and the three numbers off the label.
 */
/**
 * Re-adding preserves account-owned metadata and changes only membership.
 */
export function reAddedFood(prior: Food | undefined, seed: Food, now: string,
  targetStatus: "eats" | "avoid" = "eats"): Food {
  return { ...(prior ?? seed), status: targetStatus, updatedAt: now };
}

/** A bundled result gets its deterministic account-owned row before entering My Foods. */
export async function addBundledRow(
  row: CatalogRow, existing: Record<string, Food>, h: AccountHandle,
  targetStatus: "eats" | "avoid" = "eats",
): Promise<Food> {
  if (!row.offlineFoodId) throw new Error("This food is unavailable.");
  const now = new Date().toISOString();
  if (row.offlineSource === "mine") {
    const prior = existing[row.offlineFoodId];
    if (!prior) throw new Error("This food is no longer in your list.");
    assertCurrent(h);
    return reAddedFood(prior, prior, now, targetStatus);
  }
  const source = dbFood(row.offlineFoodId);
  if (!source) throw new Error("This built-in food is unavailable.");
  // The account's own row for this food and these numbers: the same id `adoptBundledFood` writes,
  // so the food in My Foods and its `user_foods` row are one food. A food added under the legacy
  // global id is still found and re-added as itself.
  const id = await bundledFoodUserId(row.offlineFoodId, h.userId);
  const legacyId = await bundledFoodUserId(row.offlineFoodId);
  assertCurrent(h);
  const prior = existing[id] ?? existing[legacyId] ?? Object.values(existing).find((food) =>
    food.name.toLocaleLowerCase() === source.name.toLocaleLowerCase());
  // Re-adding changes membership only. Re-adoption would upsert old bundled nutrition over
  // the account's edits and queue that stale row for another device.
  if (prior) return reAddedFood(prior, prior, now, targetStatus);
  if (!await adoptBundledFood(row.offlineFoodId, { account: h })) {
    throw new Error("Could not add this built-in food. Check your connection and try again.");
  }
  assertCurrent(h);
  const protein = source.per100g.protein / 100;
  const carbs = source.per100g.carbs / 100;
  const fat = source.per100g.fat / 100;
  return reAddedFood(prior, {
    id, name: source.name, role: inferFoodRole(source.name, { protein, carbs, fat }), unit: "g",
    perUnit: { protein, carbs, fat }, status: "eats", updatedAt: now,
  }, now, targetStatus);
}

export default function AddFoodSheet({
  existing,
  onAdd,
  onClose,
  startCustom = false,
  initialRole = "protein",
  targetStatus = "eats",
}: {
  existing: Record<string, Food>;
  /**
   * The food to add. The label flow also logs a serving and answers a promise: a string is a
   * refusal, and the form stays open with its draft so the user can try again.
   */
  onAdd: (food: Food) => void | Promise<string | void>;
  onClose: () => void;
  /** Open straight on the "type it from the label" form. */
  startCustom?: boolean;
  initialRole?: FoodRole;
  targetStatus?: "eats" | "avoid";
}) {
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(startCustom);
  const customAdded = useRef(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<FoodRole>(initialRole);
  const [unit, setUnit] = useState<FoodUnit>("oz");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  /** The label flow's refusal, shown on the form it came from; and its save in flight. */
  const [customError, setCustomError] = useState<string | null>(null);
  const [customSaving, setCustomSaving] = useState(false);
  // A changed form is a new food: it can be added again.
  useEffect(() => { customAdded.current = false; }, [name, role, unit, protein, carbs, fat]);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [confirmAvoid, setConfirmAvoid] = useState<string | null>(null);
  const controller = useRef(createSearchController());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const searchController = controller.current;
    let live = true;
    if (!query.trim()) return undefined;
    const h = currentAccountOrNull();
    // Discovery: a category name ("onion and garlic") also finds the foods it covers, each row
    // still carrying the server's own policy verdict.
    void searchController.search(query, { mine: existing, discover: true,
      ...(h ? { account: h } : {}) }).then(
      (result) => {
        if (!live || result === null || (h && !isCurrent(h))) return;
        setRows(toRows(result));
        setSearching(false);
      },
      () => {
        if (!live || (h && !isCurrent(h))) return;
        setRows([]);
        setSearchError("Search could not finish. Try again or use Something else below.");
        setSearching(false);
      },
    );
    return () => { live = false; searchController.cancel(); };
  }, [query, existing]);

  async function addRow(row: CatalogRow) {
    if (savingKey) return;
    const prior = Object.values(existing).find((food) =>
      food.name.toLocaleLowerCase() === row.description.toLocaleLowerCase());
    if (targetStatus === "eats" && prior?.status === "avoid" && confirmAvoid !== row.key) {
      setConfirmAvoid(row.key); return;
    }
    let h: AccountHandle;
    try { h = accountHandle(); }
    catch { setSaveError("Sign in to add a food."); return; }
    setSavingKey(row.key);
    setSaveError(null);
    try {
      const food = prior && !row.offline
        ? reAddedFood(prior, prior, new Date().toISOString(), targetStatus)
        : row.offline
        ? await addBundledRow(row, existing, h, targetStatus)
        : row.catalogFoodId !== null && row.revisionId !== null
          ? await addCatalogFood(row.catalogFoodId, row.revisionId, targetStatus)
          : null;
      assertCurrent(h);
      if (!food) throw new Error("This food is unavailable.");
      if (mounted.current) onAdd(reAddedFood(
        existing[food.id] ?? Object.values(existing).find((prior) =>
          prior.name.toLocaleLowerCase() === food.name.toLocaleLowerCase()), food,
        new Date().toISOString(), targetStatus,
      ));
    } catch (error) {
      if (mounted.current && isCurrent(h)) setSaveError(
        error instanceof Error ? error.message : "Could not add that food. Try again.");
    } finally {
      if (mounted.current && isCurrent(h)) setSavingKey(null);
    }
  }

  const num = (s: string) => Math.max(0, Number(s) || 0);
  const roleMacro = role === "protein" ? num(protein) : role === "carb" ? num(carbs) : num(fat);
  const banned = name.trim().length > 1 ? bannedReason(name) : null;
  const canSave = name.trim().length > 1 && roleMacro > 0 && !banned;

  function saveCustom() {
    // One food per typed form: a second tap before the sheet closes (the label flow logs a
    // serving with it) must not add, and log, it twice. Editing the form makes it addable again.
    if (customAdded.current) return;
    const id = slugify(name);
    if (!id) return;
    const prior = Object.values(existing).find((food) =>
      food.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    if (targetStatus === "eats" && prior?.status === "avoid" && confirmAvoid !== `custom:${prior.id}`) {
      setConfirmAvoid(`custom:${prior.id}`); return;
    }
    const now = new Date().toISOString();
    customAdded.current = true;
    setCustomError(null);
    const added = onAdd(reAddedFood(prior, {
      id: existing[id] && existing[id].name !== name.trim() ? `${id}-${Date.now().toString(36)}` : id,
      name: name.trim(),
      role,
      unit,
      perUnit: { protein: num(protein), carbs: num(carbs), fat: num(fat) },
      status: "eats",
      updatedAt: now,
    }, now, targetStatus));
    if (!(added instanceof Promise)) return;
    setCustomSaving(true);
    void added.then((refusal) => {
      if (!mounted.current) return;
      setCustomSaving(false);
      // Refused: nothing was logged, so the same draft may be sent again.
      if (typeof refusal === "string") { customAdded.current = false; setCustomError(refusal); }
    }, () => {
      if (!mounted.current) return;
      setCustomSaving(false);
      customAdded.current = false;
      setCustomError("That did not log. Try again.");
    });
  }

  if (custom) {
    return (
      <Sheet
        title="Something else"
        subtitle="Numbers per one serving, straight off the label."
        onClose={onClose}
        footer={
          <div className="flex flex-col gap-2.5">
            <Button variant="primary" size="lg" block disabled={!canSave || customSaving} onClick={saveCustom}>
              {confirmAvoid?.startsWith("custom:") ? "Add back to Eats" : "Add to my foods"}
            </Button>
            <WorkingLine active={customSaving} step="commit" />
            {customError && <Notice tone="error" title={customError} />}
            {confirmAvoid?.startsWith("custom:") && <p className={`m-0 ${ROW_META}`}>
              This food is on Avoid. Add it back to Eats?
            </p>}
            <Button variant="tertiary" block onClick={() => setCustom(false)}>Back to the list</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 px-0.5">
          <label className="flex flex-col gap-1.5">
            <span className={`pl-1.5 ${SECTION_LABEL}`}>Food name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Food name"
              placeholder="Name, e.g. Cod"
              className={`well h-12 w-full px-4 ${FIELD}`}
            />
          </label>
          {banned && (
            <p role="alert" className={`m-0 px-3.5 py-3 ${TRAY} ${ALERT}`}>
              {banned}
            </p>
          )}
          <div className="flex flex-col gap-2.5">
            <span className={`pl-1.5 ${SECTION_LABEL}`}>
              It is mostly
            </span>
            <div className="flex flex-wrap gap-2">
              {(["protein", "carb", "fat"] as FoodRole[]).map((r) => (
                <Pill key={r} active={role === r} onClick={() => setRole(r)}>
                  {ROLE_LABELS[r]}
                </Pill>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className={`pl-1.5 ${SECTION_LABEL}`}>
              One serving is
            </span>
            <div className="flex flex-wrap gap-2">
              {UNITS.map((u) => (
                <Pill key={u} active={unit === u} onClick={() => setUnit(u)}>
                  1 {UNIT_LABELS[u]}
                </Pill>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Protein g", protein, setProtein],
              ["Carbs g", carbs, setCarbs],
              ["Fat g", fat, setFat],
            ].map(([label, value, set]) => (
              <label key={label as string} className="flex flex-col gap-1.5">
                <span className={`pl-1.5 ${SECTION_LABEL}`}>
                  {label as string}
                </span>
                <input
                  inputMode="decimal"
                  value={value as string}
                  onChange={(e) => (set as (v: string) => void)(e.target.value)}
                  placeholder="0"
                  className={`well h-11 w-full px-3 tabular-nums ${FIELD}`}
                />
              </label>
            ))}
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Add a food"
      subtitle="Search the catalog, then add a food to your list."
      onClose={onClose}
      footer={
        <Button variant="tertiary" block onClick={() => { setName(query.trim()); setCustom(true); }}>
          Something else…
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className={`pl-1.5 ${SECTION_LABEL}`}>Search foods</span>
          <SearchField size="lg" value={query} label="Search foods" placeholder="Search" data-autofocus
            onValueChange={(next) => {
              setQuery(next);
              setSearching(Boolean(next.trim()));
              setSearchError(null);
              setConfirmAvoid(null);
              if (!next.trim()) setRows([]);
            }} />
        </label>
        {/* Results load after the card has opened: a reserved floor and an animated height keep the
            card still while "Searching…" gives way to rows (owner, 2026-10-04: "a bit jumpy"). */}
        <AutoHeight className="min-h-72">
        <div className="flex flex-col gap-2">
          {searching && <p className={`m-0 px-1.5 py-2 ${ROW_META}`}>Searching…</p>}
          {!searching && !searchError && query.trim() && rows.length === 0 && (
            <Notice tone="neutral" title="Nothing matches. Use “Something else” below." />
          )}
          {searchError && <Notice tone="error" title={searchError} />}
          {saveError && <Notice tone="error" title={saveError} />}
          {confirmAvoid && !confirmAvoid.startsWith("custom:") && <p className={`m-0 px-1.5 py-2 ${ROW_META}`}>
            This food is on Avoid. Select it again to add it back to Eats.
          </p>}
          {rows.length > 0 && <div className={TRAY}>
            {rows.map((row, index) => (
              <button
                key={row.key}
                type="button"
                onClick={() => { void addRow(row); }}
                disabled={savingKey !== null}
                className={`tap flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left disabled:opacity-40 ${
                  index > 0 ? "border-t border-hairline" : ""}`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`truncate ${ROW_TITLE}`}>
                    {row.description}
                  </span>
                  {/* U8: the source as the same tag every food search uses, then one serving
                      ("1 tbsp (14 g) · 126 kcal"), then the brand. */}
                  <span className={`flex min-w-0 items-center gap-1.5 ${ROW_META}`}>
                    <SourceTag tile={row.sourceTile} />
                    <span className="truncate tabular-nums">
                      <KcalText text={[rowServingLine(row, existing), row.brand].filter(Boolean).join(" · ")} />
                    </span>
                  </span>
                </span>
                <span className="chip-on flex size-9 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
                  <PlusIcon />
                </span>
              </button>
            ))}
          </div>}
        </div>
        </AutoHeight>
      </div>
    </Sheet>
  );
}
