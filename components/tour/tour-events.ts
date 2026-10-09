/**
 * Asking for the overview from anywhere on Today (tapping the companion in the well): one window
 * event, so the well needs no prop threaded through the Day card. With no host listening (the
 * design gallery), nothing happens. `origin` is the element the overview grows out of.
 */
export const TOUR_OPEN_EVENT = "tour-open-requested";

export type TourOpenDetail = { origin: Element | null };

export function requestTour(origin: Element | null = null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TourOpenDetail>(TOUR_OPEN_EVENT, { detail: { origin } }));
}
