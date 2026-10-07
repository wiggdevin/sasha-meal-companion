"use client";

/**
 * May the phone offer the taste-chip text field? (Phase 18 W5b-3.) One read of
 * `GET /api/profile/taste/enabled`, the server's `TASTE_CHIPS_ENABLED`:
 *
 *   "enabled"   200 `{ enabled: true }`
 *   "disabled"  200 `{ enabled: false }` — the switch is off; hide the field
 *   "unknown"   anything else: offline, a timeout, another status (401, 404 from a server that does
 *               not have this route yet, 5xx), another shape. Not an answer about the switch —
 *               the caller decides what an unknown shows and may read again later.
 *
 * Read only. Nothing is cached here: each call asks the server.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

export const TASTE_ENABLED_PATH = "/api/profile/taste/enabled";

export type TasteChipsAvailability = "enabled" | "disabled" | "unknown";

export async function readTasteChipsEnabled(
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<TasteChipsAvailability> {
  try {
    const h = opts.account ?? accountHandle();
    const response = await accountFetch(h, TASTE_ENABLED_PATH,
      { cache: "no-store", credentials: "same-origin" }, { budget: "prefs", fetchImpl: opts.fetchImpl });
    if (response.status !== 200) return "unknown";
    const body = await accountJson<unknown>(h, response);
    const enabled = typeof body === "object" && body !== null ? (body as { enabled?: unknown }).enabled : undefined;
    return enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown";
  } catch (e) {
    rethrowAccountChanged(e);
    return "unknown";
  }
}
