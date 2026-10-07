"use client";
/**
 * Phase 19 R2 §6.1: `onOpenSlot`, UI-owned. Takes the user to a slot's Today card: scrolls it into
 * view, expands it when it has an expand control that is not already open, and focuses a usable
 * control inside it. Works for an empty focus card and an empty standard card, which have no expand
 * control at all (components/SlotCard.tsx) — those just get scrolled to and focused.
 */
import type { SlotId } from "@/lib/types";

function isUsable(element: HTMLElement): boolean {
  return element.getAttribute("aria-hidden") !== "true" && !element.hasAttribute("disabled");
}

/** The first interactive, screen-reader-visible, enabled control inside `container`. */
function focusableIn(container: HTMLElement): HTMLElement | null {
  const candidates = container.querySelectorAll<HTMLElement>("button, a[href], [tabindex]");
  for (const candidate of candidates) if (isUsable(candidate)) return candidate;
  return null;
}

export function openSlotCard(slot: SlotId): void {
  if (typeof document === "undefined") return;
  const group = document.querySelector<HTMLElement>(`[data-slot-card="${slot}"]`);
  if (!group) return;
  group.scrollIntoView({ behavior: "smooth", block: "center" });
  // A filled card not already expanded has one "Expand <label>" button (components/SlotCardDetail.tsx);
  // an already-expanded card instead shows "Collapse <label>", so there is nothing to click. An empty
  // card has neither — scrolling and focusing it is the whole job there.
  const expand = group.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
  expand?.click();
  focusableIn(group)?.focus({ preventScroll: true });
}
