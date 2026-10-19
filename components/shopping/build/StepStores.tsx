"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Field from "@/components/ui/Field";
import { MAX_STORES } from "@/lib/shopping/build-flow";
import type { GeocodeResult, PlaceStore } from "@/lib/shopping/contracts";
import { geocodePlace, nearbyStores, PLACES_UNAVAILABLE_COPY, roundCoord, type GeocodeAnswer,
  type StoresAnswer } from "@/lib/shopping/places-client";

/** Leaflet loads only here, only on the client, only when the map is about to show (§7.4). */
const StoreMap = dynamic(() => import("@/components/shopping/StoreMap"), {
  ssr: false,
  loading: () => <p role="status" className="m-0 text-caption text-muted">Loading the map…</p>,
});

const COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ"] as const;

function locationKey(accountId: string): string { return `shopping-location:${accountId}`; }
function pickedKey(accountId: string): string { return `shopping-picked-stores:${accountId}`; }
/* Its own key: `shopping-location` becomes a list's `locale` on the server, and the store area
   must never leave the device except in the geocode call itself. */
function areaKey(accountId: string): string { return `shopping-build-area:${accountId}`; }
const MAX_AREA = 120;

/** The area this account searched last time, else the one typed on Shopping (ShoppingRoot keeps it). */
export function savedArea(accountId: string): string {
  try {
    return window.localStorage.getItem(areaKey(accountId)) ?? window.localStorage.getItem(locationKey(accountId)) ?? "";
  } catch { return ""; }
}
/** Keeps the area for next time, on this device only. */
function saveArea(accountId: string, area: string) {
  try { window.localStorage.setItem(areaKey(accountId), area.trim().slice(0, MAX_AREA)); } catch { /* storage blocked */ }
}
/** Store names this account picked last time, at most five. */
export function savedPickedStores(accountId: string): string[] {
  try {
    const raw = window.localStorage.getItem(pickedKey(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string").slice(0, MAX_STORES) : [];
  } catch { return []; }
}
export function rememberPickedStores(accountId: string, names: readonly string[]): void {
  try {
    if (names.length) window.localStorage.setItem(pickedKey(accountId), JSON.stringify(names.slice(0, MAX_STORES)));
    else window.localStorage.removeItem(pickedKey(accountId));
  } catch { /* Picks are a convenience; the list saves without them. */ }
}

export type PlacesPort = {
  geocode: (q: string, country: string) => Promise<GeocodeAnswer>;
  stores: (lat: number, lon: number) => Promise<StoresAnswer>;
  /** The phone's coarse position, asked only after a direct tap. */
  locate: () => Promise<{ lat: number; lon: number } | null>;
};

function browserLocate(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: roundCoord(position.coords.latitude), lon: roundCoord(position.coords.longitude) }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: 10_000 });
  });
}

export const DEFAULT_PLACES: PlacesPort = {
  geocode: (q, country) => geocodePlace(q, country),
  stores: (lat, lon) => nearbyStores(lat, lon),
  locate: browserLocate,
};

type Phase =
  | { kind: "area" }
  | { kind: "busy"; text: string }
  | { kind: "confirm"; place: GeocodeResult }
  | { kind: "map"; place: GeocodeResult; stores: PlaceStore[] }
  | { kind: "unavailable" };

/**
 * Step 4, Stores (optional, UI makeover §7.4): a typed area and a country, or the phone's coarse
 * location after a direct tap; "Near … Is this right?" before any store search; then the map.
 * Nothing about the place is stored on the server; the picked names stay on this phone.
 */
export default function StepStores({ accountId, countryCode, picked, onToggle, onNext, onSkip,
  places = DEFAULT_PLACES }: {
  accountId: string;
  countryCode: string | null;
  picked: PlaceStore[];
  onToggle: (store: PlaceStore) => void;
  onNext: () => void;
  onSkip: () => void;
  places?: PlacesPort;
}) {
  const [area, setArea] = useState(() => savedArea(accountId));
  const [country, setCountry] = useState<string | null>(countryCode);
  const [phase, setPhase] = useState<Phase>({ kind: "area" });
  const [error, setError] = useState<string | null>(null);
  const countries = countryCode && !(COUNTRIES as readonly string[]).includes(countryCode)
    ? [countryCode, ...COUNTRIES] : [...COUNTRIES];

  async function find() {
    if (!area.trim()) { setError("Type a ZIP code, postcode or neighborhood."); return; }
    if (!country) { setError("Pick your country first."); return; }
    setError(null);
    setPhase({ kind: "busy", text: "Finding that place…" });
    const answer = await places.geocode(area, country);
    if (answer.status === "ok") { saveArea(accountId, area); setPhase({ kind: "confirm", place: answer.place }); }
    else if (answer.status === "unavailable") setPhase({ kind: "unavailable" });
    else {
      setPhase({ kind: "area" });
      setError(answer.status === "not_found" ? "We couldn't find that place. Try a ZIP code or a nearby city."
        : "That didn't work. Try again.");
    }
  }
  async function locate() {
    setError(null);
    setPhase({ kind: "busy", text: "Finding where you are…" });
    const spot = await places.locate();
    if (!spot) { setPhase({ kind: "area" }); setError("Your location isn't available. Type an area instead."); return; }
    setPhase({ kind: "confirm", place: { ...spot, label: "your location" } });
  }
  async function loadStores(place: GeocodeResult) {
    setPhase({ kind: "busy", text: "Finding stores nearby…" });
    const answer = await places.stores(place.lat, place.lon);
    if (answer.status === "ok") {
      setPhase({ kind: "map", place, stores: answer.stores });
      // Last time's picks, by name, when the same stores turn up again.
      const remembered = savedPickedStores(accountId);
      if (!picked.length) {
        for (const store of answer.stores.filter((row) => remembered.includes(row.name)).slice(0, MAX_STORES)) onToggle(store);
      }
    } else if (answer.status === "unavailable") setPhase({ kind: "unavailable" });
    else { setPhase({ kind: "confirm", place }); setError("Stores didn't load. Try again."); }
  }
  function toggle(store: PlaceStore) {
    const on = picked.some((row) => row.id === store.id);
    const names = on ? picked.filter((row) => row.id !== store.id).map((row) => row.name)
      : picked.length < MAX_STORES ? [...picked.map((row) => row.name), store.name] : picked.map((row) => row.name);
    rememberPickedStores(accountId, names);
    onToggle(store);
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-body font-semibold text-charcoal">Stores near you</h3>
      {phase.kind === "area" && <>
        <Field id="build-area" label="ZIP code or area" autoComplete="postal-code" value={area} error={error}
          maxLength={MAX_AREA}
          onChange={(event) => { setArea(event.target.value); setError(null); }} />
        <div className="pill-in flex flex-wrap gap-1" role="group" aria-label="Country">
          {countries.map((code) => (
            <Chip key={code} selected={country === code} onClick={() => { setCountry(code); setError(null); }}>{code}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => { void find(); }}>Find stores</Button>
          <Button variant="secondary" onClick={() => { void locate(); }}>Use my location</Button>
        </div>
      </>}
      {phase.kind === "busy" && <p role="status" className="m-0 text-caption text-muted">{phase.text}</p>}
      {phase.kind === "confirm" && <>
        <p className="m-0 text-body text-charcoal">Near {phase.place.label}. Is this right?</p>
        {error && <p role="alert" className="m-0 text-caption text-alert">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="tertiary" onClick={() => { setPhase({ kind: "area" }); setError(null); }}>Change</Button>
          <Button variant="primary" onClick={() => { setError(null); void loadStores(phase.place); }}>Yes, show stores</Button>
        </div>
      </>}
      {phase.kind === "map" && (phase.stores.length === 0
        ? <p className="m-0 text-body text-muted">No stores found near {phase.place.label}.</p>
        : <StoreMap center={{ lat: phase.place.lat, lon: phase.place.lon }} stores={phase.stores}
          pickedIds={picked.map((store) => store.id)} onToggle={toggle} />)}
      {phase.kind === "unavailable" && <p className="m-0 text-body text-muted">{PLACES_UNAVAILABLE_COPY}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="tertiary" onClick={onSkip}>Skip</Button>
        {phase.kind === "map" && picked.length > 0 && <Button variant="primary" onClick={onNext}>Next: save</Button>}
      </div>
    </div>
  );
}
