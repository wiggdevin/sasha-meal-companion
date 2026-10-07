/**
 * Where an anchored pop-up card sits (components/Sheet ModalSheet, components/TimeWheelSheet).
 * The owner asked for no bottom sheets (2026-10-03): a tap opens a card right next to the thing
 * that was tapped, so the finger barely moves. Pure, so it is unit-testable without layout.
 *
 * The card is centred on the screen with a gutter and a max width; vertically it sits below the
 * trigger when it fits there, above it when it fits there instead, and otherwise on the roomier
 * side, clamped into the usable area. With no trigger it is centred. The transform origin is the
 * trigger's centre relative to the card, so the card scales out of (and back into) the trigger.
 */

export type PopoverRect = { top: number; bottom: number; left: number; right: number };

export type PopoverSide = "below" | "above" | "center";

export type PopoverInput = {
  /** The trigger's viewport rect, or null when nothing opened the card. */
  trigger: PopoverRect | null;
  /** Viewport width in px. */
  viewportWidth: number;
  /** The usable band, in viewport px: below the safe-area top, above the safe area and the dock. */
  areaTop: number;
  areaBottom: number;
  /** The card's natural height in px (what it would take with no cap). */
  cardHeight: number;
  /** Keep this side once chosen, so a card that grows does not jump across its trigger. */
  side?: PopoverSide;
  /** The positioning layer's height in px. Given, an "above" card also reports `bottom`. */
  layerHeight?: number;
  gutter?: number;
  gap?: number;
  maxWidth?: number;
};

export type PopoverPlacement = {
  side: PopoverSide;
  top: number;
  left: number;
  width: number;
  /** The tallest the card may be; its body scrolls inside it past this. */
  maxHeight: number;
  /**
   * Above the trigger (with `layerHeight`): the card's bottom edge, from the layer's bottom. A card
   * anchored here grows upward in the same layout pass, so late content never makes it jump.
   */
  bottom?: number;
  originX: number;
  originY: number;
};

export const POPOVER_GUTTER = 16;
export const POPOVER_GAP = 8;
export const POPOVER_MAX_WIDTH = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** A rect with no size (a detached or hidden element) is no anchor at all. */
function usable(rect: PopoverRect | null, areaTop: number, areaBottom: number): rect is PopoverRect {
  if (!rect) return false;
  if (rect.right - rect.left <= 0 && rect.bottom - rect.top <= 0) return false;
  return rect.bottom > areaTop - 1 && rect.top < areaBottom + 1;
}

export function placePopover(input: PopoverInput): PopoverPlacement {
  const gutter = input.gutter ?? POPOVER_GUTTER;
  const gap = input.gap ?? POPOVER_GAP;
  const maxWidth = input.maxWidth ?? POPOVER_MAX_WIDTH;
  const width = Math.max(0, Math.min(maxWidth, input.viewportWidth - gutter * 2));
  const left = (input.viewportWidth - width) / 2;
  const top0 = input.areaTop + gutter;
  const bottom0 = Math.max(top0, input.areaBottom - gutter);
  const maxHeight = bottom0 - top0;
  const height = Math.min(Math.max(0, input.cardHeight), maxHeight);
  const trigger = input.trigger;

  // A card that has already taken a side keeps it even when its trigger leaves the band (the
  // phone keyboard rising over an Add button at the bottom of a list): it clamps above the keyboard
  // rather than jumping to the middle of the screen.
  const anchored = trigger !== null && (input.side ? input.side !== "center"
    : usable(trigger, input.areaTop, input.areaBottom));
  if (!anchored || !trigger) {
    const top = top0 + (maxHeight - height) / 2;
    return { side: "center", top, left, width, maxHeight, originX: width / 2, originY: height / 2 };
  }

  const spaceBelow = bottom0 - (trigger.bottom + gap);
  const spaceAbove = trigger.top - gap - top0;
  const side: PopoverSide = input.side
    ?? (height <= spaceBelow ? "below" : height <= spaceAbove ? "above" : spaceBelow >= spaceAbove ? "below" : "above");
  const wanted = side === "below" ? trigger.bottom + gap : trigger.top - gap - height;
  const top = clamp(wanted, top0, bottom0 - height);
  const centreX = (trigger.left + trigger.right) / 2;
  const centreY = (trigger.top + trigger.bottom) / 2;
  const placed = { side, top, left, width, maxHeight, originX: centreX - left, originY: centreY - top };
  return side === "above" && input.layerHeight !== undefined
    ? { ...placed, bottom: input.layerHeight - (top + height) } : placed;
}
