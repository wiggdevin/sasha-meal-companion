"use client";

import { accountFetch, accountHandle, accountJson, assertCurrent } from "@/lib/device/account";
import { PREFERENCE_FLAGS, type PreferenceFlag } from "@/lib/profile/onboarding-state";
import { loadStore, saveStore } from "@/lib/store";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import { flushOutboxNow, syncOnce } from "@/lib/sync/client";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import type { AccountHandle } from "@/lib/device/account";

export type DietState = { dietPrefs: ProfileDietPrefs | null; rev: number };
function validFlags(value: unknown): PreferenceFlag[] {
  if (!Array.isArray(value)) return [];
  return PREFERENCE_FLAGS.filter((flag) => value.includes(flag));
}
export async function loadDiet(h: AccountHandle = accountHandle()): Promise<DietState> {
  const res = await accountFetch(h, "/api/foods/diet", { cache: "no-store" }, { budget: "prefs" });
  if (!res.ok) throw new Error("Could not load diet settings.");
  const body = await accountJson<{ dietPrefs: ProfileDietPrefs | null; rev: number }>(h, res);
  return { dietPrefs: body.dietPrefs ? { ...body.dietPrefs,
    flags: validFlags(body.dietPrefs.flags) } : null, rev: body.rev };
}
export async function saveDiet(flags: readonly PreferenceFlag[], baseRev: number): Promise<DietState> {
  const h = accountHandle();
  // Settle this device's older settings intents, then pull the current server row before
  // deriving the confirmed edit. A stale mirror must not overwrite another device's prefs.
  if (!await flushOutboxNow(h)) throw new Error("Pending profile changes need to sync before changing diet style.");
  await syncOnce(h);
  assertCurrent(h);
  const before = await loadDiet(h);
  if (before.rev !== baseRev) throw new Error("Diet settings changed elsewhere. Reload and review them.");
  assertCurrent(h);
  // The coach's syncProfileSettings uses this same atomic settings-intent transaction.
  // This writer supplies only the fresh server diet field; the transaction owns the
  // rest of the row and rejects a mirror revision that changed under this confirmation.
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    if (rev !== before.rev) throw new Error("Diet settings changed during sync. Reload and review them.");
    const nextPrefs: ProfileDietPrefs = { ...(before.dietPrefs ?? {}),
      flags: validFlags(flags) };
    const payload = { diet_prefs: nextPrefs };
    return { row: { ...row, ...payload }, op: { op_id: crypto.randomUUID(),
      entity: "user_settings" as const, entity_id: USER_SETTINGS_KEY,
      kind: rev === null ? "create" as const : "update" as const, base_rev: rev,
      payload, client_ts: new Date().toISOString() }, result: undefined };
  });
  if (!await flushOutboxNow(h)) throw new Error("Diet change is queued on this device. Reconnect and check before editing again.");
  assertCurrent(h);
  const saved = await loadDiet(h);
  if (JSON.stringify(validFlags(saved.dietPrefs?.flags)) !== JSON.stringify(validFlags(flags))) {
    throw new Error("Diet settings changed during sync. Reload and review them.");
  }
  const current = loadStore();
  saveStore({ ...current, settings: { ...current.settings, dietPrefs: saved.dietPrefs } });
  return saved;
}
