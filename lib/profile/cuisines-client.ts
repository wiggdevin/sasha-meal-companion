/**
 * Saving the account's cuisines or country (Phase 18 W5) from Settings: one `user_settings` op that
 * carries that one column, queued through the outbox like every profile field (so it holds offline),
 * then the phone's settings blob. Only a valid value is ever passed: the chips cap at 6 from the
 * vocabulary and the picker lists ISO codes only, and `settingsProfileToRow` leaves out anything
 * else rather than park the settings op.
 */
import { syncProfileSettings } from "@/lib/coach/apply-profile";
import { accountHandle, assertCurrent } from "@/lib/device/account";
import type { CuisineKey } from "@/lib/profile/cuisines";
import { loadStore, saveStoreFor } from "@/lib/store";

export type PlacePatch = { cuisines: CuisineKey[] } | { countryCode: string | null };

export async function savePlaceSetting(
  patch: PlacePatch,
  deps: { sync: typeof syncProfileSettings } = { sync: syncProfileSettings },
): Promise<void> {
  const h = accountHandle();
  const store = loadStore();
  const settings = { ...store.settings, ...patch };
  await deps.sync(settings, h, "cuisines" in patch ? ["cuisines"] : ["countryCode"]);
  assertCurrent(h);
  // Re-read: another write may have saved the blob while the op was queued.
  const latest = loadStore();
  saveStoreFor(h, { ...latest, settings: { ...latest.settings, ...patch } });
}
