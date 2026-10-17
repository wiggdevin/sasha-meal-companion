/**
 * The chosen background, kept on the phone per account (`smc:u:<id>:ground`). It is a display
 * preference, so it is not synced and has no server column; a new phone starts on Oat.
 */
import { type AccountHandle } from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";
import { DEFAULT_GROUND, isGroundId, type GroundId } from "./grounds";
import { themeColorFor } from "./theme-color";

const NAME = "ground";
export const GROUND_EVENT = "smc:ground";

export function readGround(h: AccountHandle): GroundId {
  const raw = readAccountItem(h, NAME);
  return isGroundId(raw) ? raw : DEFAULT_GROUND;
}

export function saveGround(h: AccountHandle, id: GroundId): void {
  writeAccountItem(h, NAME, id);
  applyGround(id);
}

/** Paints a ground: `<html data-ground>` drives the CSS, the meta tag drives the browser chrome. */
export function applyGround(id: GroundId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.ground = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeColorFor(id));
  window.dispatchEvent(new Event(GROUND_EVENT));
}

export function currentGround(): GroundId {
  if (typeof document === "undefined") return DEFAULT_GROUND;
  const raw = document.documentElement.dataset.ground;
  return isGroundId(raw) ? raw : DEFAULT_GROUND;
}
