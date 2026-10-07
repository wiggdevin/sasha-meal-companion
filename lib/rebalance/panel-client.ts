"use client";
/**
 * Phase 19 R2: the read-only "Rebalance my day" panel's client hook. Wiring (§6.1):
 * resolveDay -> projectPanelSlots(day, storedDay) -> dayBalance(day, slots, panelNow(now)) ->
 * classifyDay(date, targetDayFor(now), balance) -> buildRebalancePanel. Every render re-reads the
 * store and re-runs that pipeline — nothing here is cached or predicted — so a store change this
 * page already re-rendered for is reflected at once; `SYNCED_EVENT` and a minute tick force a
 * re-render on their own for the case nothing else would (a background sync, or time passing).
 *
 * GATE: `GET /api/rebalance/access` -> `{ enabled: boolean }`, once per account. FAIL CLOSED: a
 * 401 (signed out), a 404 (the route may not exist yet), any other non-ok status, a timeout, a
 * malformed body or `enabled !== true` all mean hidden. No development or localhost fallback (spec
 * D6/D10): the clinical copy review alone turns this on, in every environment.
 */
import { useEffect, useState } from "react";
import {
  accountFetch, accountJson, currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle,
} from "@/lib/device/account";
import { projectPanelSlots } from "@/lib/plan/panel-slots";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { targetDayFor } from "@/lib/targets/revision";
import { todayResolveInputs, type TodayLive } from "@/lib/today/resolve-inputs";
import { dayBalance, panelNow } from "./balance";
import { classifyDay } from "./classify";
import { buildRebalancePanel, type RebalancePanel } from "./panel";

const HIDDEN: RebalancePanel = { show: false };
const MINUTE_MS = 60_000;

async function readRebalanceAccess(account: AccountHandle): Promise<boolean> {
  try {
    const response = await accountFetch(account, "/api/rebalance/access",
      { cache: "no-store" }, { budget: "prefs" });
    if (!response.ok) return false;
    const body = await accountJson<{ enabled?: unknown }>(account, response);
    return body?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Read-only panel state for "Rebalance my day". `date` is the viewed date; the panel hides itself
 * on every date but the device's local today (`classifyDay`'s `hidden` row). `live` is the same
 * object Today resolves its own day from (app/page.tsx): the hook passes it through the same
 * builder (lib/today/resolve-inputs.ts) after its fresh store read, so the panel resolves exactly
 * the day Today shows — eligible Eats, the dated recipe overlay and the live rule-review readiness
 * included. Without `live` (a test, or a caller with no page state) the stored day resolves as stored.
 */
export function useRebalancePanel(date: string, live?: TodayLive): RebalancePanel {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [enabled, setEnabled] = useState(false);
  const [, bump] = useState(0);

  useEffect(() => {
    const ready = onAccountReady((next) => setAccount((previous) =>
      previous?.epoch === next.epoch ? previous : next));
    const gone = onAccountGone(() => { setAccount(null); setEnabled(false); });
    return () => { ready(); gone(); };
  }, []);

  useEffect(() => {
    // A null account is already covered below (!account short-circuits to HIDDEN): nothing to
    // fetch, and no setState needed here for that case.
    if (!account) return;
    let live = true;
    void readRebalanceAccess(account).then((ok) => { if (live) setEnabled(ok); });
    return () => { live = false; };
    // Re-checked once per account; the gate is a server allowlist, not expected to flip mid-session.
  }, [account]);

  useEffect(() => {
    const tick = () => bump((value) => value + 1);
    window.addEventListener(SYNCED_EVENT, tick);
    const timer = window.setInterval(tick, MINUTE_MS);
    return () => { window.removeEventListener(SYNCED_EVENT, tick); window.clearInterval(timer); };
  }, []);

  if (!account || !enabled) return HIDDEN;
  const stored = loadStore();
  const { store, args } = todayResolveInputs(stored, date, live ?? {
    accepted: null, recipeAccessEnabled: false, ruleReviewReady: stored.settings.ruleReviewReady === true,
  });
  const now = new Date();
  const day = resolveDay(...args);
  const slots = projectPanelSlots(day, store.days[date]);
  const balance = dayBalance(day, slots, panelNow(now));
  const state = classifyDay(date, targetDayFor(now), balance);
  return buildRebalancePanel(state, balance, day);
}
