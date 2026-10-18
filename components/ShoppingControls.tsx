"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import DateField from "@/components/ui/DateField";
import GlassSelect from "@/components/ui/GlassSelect";
import type { ShoppingPeriod } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";

export type ShoppingDraft = Pick<ShoppingPeriod, "startDate" | "endDate" | "timezone" | "people" |
  "mealCoverage" | "mode" | "effort" | "maxActiveMinutes" | "variety" |
  "budgetAmount" | "currency" | "locale" | "lockMode">;

export function realCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Why a draft cannot be previewed (or saved as a blank list, which needs no meals), in the words
 * the planner shows beside its button; null when it can.
 */
export function draftProblem(draft: ShoppingDraft, { needMeals = true }: { needMeals?: boolean } = {}): string | null {
  if (!realCalendarDate(draft.startDate) || !realCalendarDate(draft.endDate)) return "Enter real calendar dates.";
  if (draft.endDate < draft.startDate) return "Through must be on or after From.";
  if (!Number.isInteger(draft.people) || draft.people < 1) return "People must be 1 or more.";
  if (needMeals && !draft.mealCoverage.length) return "Pick at least one meal.";
  return null;
}

function shiftDate(date: string, days: number): string {
  if (!realCalendarDate(date)) return "";
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return "";
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function monthEnd(start: string): string {
  if (!realCalendarDate(start)) return "";
  const value = new Date(`${start}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return "";
  const next = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1, 12));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}
export function defaultShoppingDraft(startDate: string, timezone: string): ShoppingDraft {
  return { startDate, endDate: shiftDate(startDate, 6), timezone, people: 1,
    mealCoverage: ["dinner"], mode: "balanced", effort: "standard", maxActiveMinutes: null,
    variety: "balanced", budgetAmount: null, currency: null, locale: null, lockMode: "none" };
}

const STANDARD_MEALS = [
  ["meal-1", "Breakfast", "breakfast"],
  ["meal-2", "Lunch", "lunch"],
  ["meal-3", "Dinner", "dinner"],
  ["meal-4", "Snack", "snack"],
] as const;

function coverageSlot(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (/^meal-[1-6]$/.test(normalized)) return normalized;
  const aliases: Record<string, string> = {
    breakfast: "meal-1", lunch: "meal-2", dinner: "meal-3", snack: "meal-4",
  };
  return aliases[normalized] ?? null;
}

export default function ShoppingControls({ draft, onChange, onPreview, busy = false,
  storeNotes = "", onStoreNotesChange }: {
  draft: ShoppingDraft; onChange: (next: ShoppingDraft) => void; onPreview: () => void; busy?: boolean;
  storeNotes?: string; onStoreNotesChange?: (value: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  /** The People field as typed, so it can be cleared to retype; the draft holds the number. */
  const [peopleText, setPeopleText] = useState({ base: draft.people, value: String(draft.people) });
  const people = peopleText.base === draft.people ? peopleText.value : String(draft.people);
  const latestDraft = useRef(draft);
  const mounted = useRef(true);
  useEffect(() => { latestDraft.current = draft; }, [draft]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function set<K extends keyof ShoppingDraft>(key: K, value: ShoppingDraft[K]) {
    const next = { ...latestDraft.current, [key]: value };
    latestDraft.current = next;
    onChange(next);
  }
  const range = draft.startDate && draft.endDate ? Math.round((new Date(`${draft.endDate}T12:00:00Z`).getTime() -
    new Date(`${draft.startDate}T12:00:00Z`).getTime()) / 86400000) + 1 : 0;
  const period = custom ? "Custom" : range === 7 ? "7 days" : range >= 28 && range <= 31 ? "Month" : "Custom";
  const problem = draftProblem(draft);
  function useLocation() {
    setLocationError(null);
    if (!navigator.geolocation) { setLocationError("This browser cannot share a location. Enter a ZIP or area instead."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition((position) => {
      if (!mounted.current) return;
      // Coarse coordinates are sufficient for a future nearby-store lookup.
      set("locale", `Near ${position.coords.latitude.toFixed(2)}, ${position.coords.longitude.toFixed(2)}`);
      setLocating(false);
    }, () => {
      if (!mounted.current) return;
      setLocating(false);
      setLocationError("Location was not shared. Enter a ZIP or area instead.");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }
  return <section className="shell"><div className="surface flex flex-col gap-4 p-4">
    <h2 className="m-0 text-lg font-semibold">Plan this shop</h2>
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Period">
      {(["7 days", "Custom", "Month"] as const).map((value) => <Button key={value} className="min-w-0 px-2"
        aria-pressed={period === value} variant={period === value ? "primary" : "quiet"}
        onClick={() => {
          setCustom(value === "Custom");
          if (value === "Custom") return;
          set("endDate", value === "7 days" ? shiftDate(draft.startDate, 6) : monthEnd(draft.startDate));
        }}>{value}</Button>)}
    </div>
    <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">From<DateField label="From" className="min-h-11 px-3" value={draft.startDate}
        onChange={(next) => { const startDate = next ?? ""; onChange({ ...draft, startDate,
          endDate: period === "7 days" ? shiftDate(startDate, 6) : period === "Month" ? monthEnd(startDate)
            // A later From in Custom carries Through with it rather than leaving it before From.
            : realCalendarDate(startDate) && draft.endDate < startDate ? startDate : draft.endDate }); }} /></label>
      <label className="flex flex-col gap-1 text-sm">Through<DateField label="Through" className="min-h-11 px-3" min={draft.startDate}
        value={draft.endDate} onChange={(next) => { setCustom(true); set("endDate", next ?? ""); }} /></label>
    </div>
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-2 text-sm">Meals covered</legend>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Meals covered">
        {[...STANDARD_MEALS, ...(["meal-5", "meal-6"] as const)
          .filter((slot) => draft.mealCoverage.some((value) => coverageSlot(value) === slot))
          .map((slot) => [slot, `Meal ${slot.slice(-1)}`, slot] as const)]
          .map(([slot, label, value]) => {
            const selected = draft.mealCoverage.some((meal) => coverageSlot(meal) === slot);
            return <Button key={slot} variant={selected ? "primary" : "quiet"}
              aria-pressed={selected}
              onClick={() => {
                const withoutSlot = draft.mealCoverage.filter((meal) => coverageSlot(meal) !== slot);
                set("mealCoverage", selected ? withoutSlot : [...withoutSlot, value]);
              }}>{label}</Button>;
          })}
      </div>
    </fieldset>
    <div className="grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1 text-sm">People<input className="well min-h-11 px-3" type="number" min="1" step="1"
        inputMode="numeric" value={people} onChange={(event) => {
          const value = event.target.value;
          const next = value.trim() === "" ? 0 : Number(value);
          const count = Number.isFinite(next) ? next : 0;
          setPeopleText({ base: count, value });
          set("people", count);
        }} /></label>
      <div className="flex flex-col gap-1 text-sm">Cooking effort<GlassSelect aria-label="Cooking effort" value={draft.effort}
        onChange={(value) => set("effort", value as ShoppingDraft["effort"])}
        options={[{ value: "none", label: "No cooking" }, { value: "minimal", label: "Minimal" },
          { value: "standard", label: "Standard" }]} /></div>
      <div className="flex flex-col gap-1 text-sm">List style<GlassSelect aria-label="List style" value={draft.mode}
        onChange={(value) => set("mode", value as ShoppingDraft["mode"])}
        options={[{ value: "simple", label: "Keep it simple" }, { value: "balanced", label: "Balanced" }]} /></div>
      <div className="flex flex-col gap-1 text-sm">Variety<GlassSelect aria-label="Variety" value={draft.variety}
        onChange={(value) => set("variety", value as ShoppingDraft["variety"])}
        options={[{ value: "repeat_friendly", label: "Repeat friendly" }, { value: "balanced", label: "Balanced" },
          { value: "high", label: "More variety" }]} /></div>
      <label className="flex flex-col gap-1 text-sm">Max active minutes<input className="well min-h-11 px-3" type="number" min="1"
        value={draft.maxActiveMinutes ?? ""} onChange={(event) => set("maxActiveMinutes", event.target.value ? Number(event.target.value) : null)} /></label>
      <label className="flex flex-col gap-1 text-sm">Budget (optional)<input className="well min-h-11 px-3" type="number" min="0" step="0.01"
        value={draft.budgetAmount ?? ""} onChange={(event) => set("budgetAmount", event.target.value ? Number(event.target.value) : null)} /></label>
    </div>
    <div className="flex flex-col gap-2"><label className="flex flex-col gap-1 text-sm">Shopping area (optional)
      <input className="well min-h-11 px-3" maxLength={80} placeholder="ZIP, city, or coarse address"
        value={draft.locale ?? ""} onChange={(event) => set("locale", event.target.value || null)} /></label>
      <Button variant="quiet" disabled={locating} onClick={useLocation}>
        {locating ? "Finding approximate area…" : "Use my location"}</Button>
      <label className="flex flex-col gap-1 text-sm">Preferred stores (optional notes)
        <input className="well min-h-11 px-3" maxLength={160} value={storeNotes}
          placeholder="Stores you already use" onChange={(event) => onStoreNotesChange?.(event.target.value)} /></label>
      {locationError && <Notice tone="error" title={locationError} />}
      <p className="ground-muted m-0 text-sm">Store notes stay on this device for this account. Nearby store search and local prices are unavailable.</p>
    </div>
    <fieldset className="m-0 border-0 p-0"><legend className="mb-2 text-sm">Which ingredients to use</legend>
      {([ ["none", "Prefer this list"], ["ingredients", "Use only these ingredients"],
        ["available_quantities", "Use only what I have"] ] as const).map(([value, label]) =>
        <label key={value} className="flex min-h-11 items-center gap-3 text-sm">
          <input type="radio" name="shopping-lock" checked={draft.lockMode === value}
            onChange={() => set("lockMode", value)} />{label}</label>)}
    </fieldset>
    {draft.lockMode !== "none" && <p className="ground-muted m-0 text-sm">Meals use only the ingredients you picked below and what you have, seasonings included. The preview lists anything that won&apos;t fit.</p>}
    {problem && <Notice tone="error" title={problem} />}
    <Button variant="primary" disabled={busy || problem !== null} onClick={onPreview}>
      {busy ? "Preparing preview…" : "Preview changes"}</Button>
  </div></section>;
}
