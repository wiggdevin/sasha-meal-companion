"use client";

/**
 * The nearby-store map of "Have AI build my list" (UI makeover §7.4). Loaded only through
 * `next/dynamic(..., { ssr: false })` from components/shopping/build/StepStores.tsx, so Leaflet
 * never reaches a route's first load.
 *
 * - OpenStreetMap tiles, zoom 12–17; "© OpenStreetMap contributors" is always on the map's face.
 * - On a touch screen one finger scrolls the page and two move the map ("Use two fingers to move
 *   the map"); pinch zooms.
 * - Each store is a 44 px marker, ✓ when picked. The rows under the map are the same stores and
 *   the same picks, 44 px each, for anyone who would rather not poke a map. At most five picks.
 * - `invalidateSize()` once the step has opened (its height springs in) and on every resize, so
 *   tiles never paint into a stale box.
 */
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAX_STORES } from "@/lib/shopping/build-flow";
import type { PlaceStore } from "@/lib/shopping/contracts";
import styles from "./StoreMap.module.css";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const ATTRIBUTION = "© OpenStreetMap contributors";
export const TWO_FINGER_HINT = "Use two fingers to move the map";
/** The step's own height spring settles inside this; the map measures again after it. */
const AFTER_OPEN_MS = 400;

export function distanceLabel(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return "";
  return metres < 1000 ? `${Math.max(10, Math.round(metres / 10) * 10)} m` : `${(metres / 1000).toFixed(1)} km`;
}

function isTouch(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
}

function pinIcon(picked: boolean): L.DivIcon {
  return L.divIcon({
    className: styles.marker,
    html: `<span class="${styles.pin}${picked ? ` ${styles.pinPicked}` : ""}" aria-hidden="true">${picked ? "✓" : ""}</span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

export type StoreMapProps = {
  center: { lat: number; lon: number };
  stores: PlaceStore[];
  pickedIds: string[];
  onToggle: (store: PlaceStore) => void;
};

export default function StoreMap({ center, stores, pickedIds, onToggle }: StoreMapProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const latest = useRef({ onToggle, pickedIds });
  const [touch] = useState(isTouch);
  const [hint, setHint] = useState(false);
  const full = pickedIds.length >= MAX_STORES;

  useEffect(() => { latest.current = { onToggle, pickedIds }; }, [onToggle, pickedIds]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const view = L.map(element, {
      center: [center.lat, center.lon], zoom: 14, minZoom: 12, maxZoom: 17,
      attributionControl: false, scrollWheelZoom: false, dragging: !touch, touchZoom: true,
    });
    L.tileLayer(TILE_URL, { minZoom: 12, maxZoom: 17, attribution: ATTRIBUTION }).addTo(view);
    map.current = view;
    const owned = markers.current;

    const invalidate = () => { view.invalidateSize(); };
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(invalidate) : null;
    const settled = setTimeout(invalidate, AFTER_OPEN_MS);
    window.addEventListener("resize", invalidate);

    let hideHint: ReturnType<typeof setTimeout> | null = null;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length >= 2) { view.dragging.enable(); setHint(false); return; }
      view.dragging.disable();
      setHint(true);
      if (hideHint) clearTimeout(hideHint);
      hideHint = setTimeout(() => setHint(false), 1500);
    };
    const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) view.dragging.disable(); };
    if (touch) {
      element.addEventListener("touchstart", onTouchStart, { passive: true });
      element.addEventListener("touchend", onTouchEnd, { passive: true });
    }
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(settled);
      if (hideHint) clearTimeout(hideHint);
      window.removeEventListener("resize", invalidate);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchend", onTouchEnd);
      owned.clear();
      view.remove();
      map.current = null;
    };
  }, [center.lat, center.lon, touch]);

  // Markers follow the stores and the picks.
  useEffect(() => {
    const view = map.current;
    if (!view) return;
    const ids = new Set(stores.map((store) => store.id));
    for (const [id, marker] of markers.current) {
      if (!ids.has(id)) { marker.remove(); markers.current.delete(id); }
    }
    for (const store of stores) {
      const picked = pickedIds.includes(store.id);
      const existing = markers.current.get(store.id);
      if (existing) { existing.setIcon(pinIcon(picked)); continue; }
      const marker = L.marker([store.lat, store.lon], { icon: pinIcon(picked), title: store.name, alt: store.name })
        .addTo(view);
      marker.on("click", () => {
        const { onToggle: toggle, pickedIds: now } = latest.current;
        if (!now.includes(store.id) && now.length >= MAX_STORES) return;
        toggle(store);
      });
      markers.current.set(store.id, marker);
    }
  }, [stores, pickedIds]);

  // The view fits the stores whenever a new set arrives (not on every pick).
  useEffect(() => {
    const view = map.current;
    if (!view || stores.length === 0) return;
    const points = stores.map((store) => [store.lat, store.lon] as [number, number]);
    view.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: 16 });
  }, [stores]);

  return (
    <div className="flex flex-col gap-2">
      <div className={styles.frame}>
        <div ref={box} className={styles.map} role="application" aria-label="Map of stores nearby" />
        {touch && (
          <p aria-hidden="true" className={`${styles.hint} ${hint ? styles.hintOn : ""} m-0 text-body`}>
            {TWO_FINGER_HINT}
          </p>
        )}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer"
          className={`${styles.attribution} text-tiny`}>{ATTRIBUTION}</a>
      </div>
      {touch && <p className="m-0 text-caption text-muted">{TWO_FINGER_HINT}.</p>}
      <p className="m-0 text-caption text-muted" aria-live="polite">
        {full ? `${MAX_STORES} of ${MAX_STORES} picked. Unpick one to choose another.`
          : `Pick up to ${MAX_STORES} stores.`}
      </p>
      <ul className={styles.rows} aria-label="Stores nearby">
        {stores.map((store) => {
          const on = pickedIds.includes(store.id);
          return (
            <li key={store.id}>
              <button type="button" className={`${styles.row} tap`} aria-pressed={on}
                disabled={!on && full} onClick={() => onToggle(store)}>
                <span aria-hidden="true" className={`${styles.check} ${on ? styles.checkOn : ""}`}>{on ? "✓" : ""}</span>
                <span className="min-w-0 flex-1 truncate text-body text-charcoal">{store.name}</span>
                <span className="shrink-0 text-caption text-muted">{distanceLabel(store.distanceM)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
