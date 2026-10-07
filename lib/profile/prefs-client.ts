"use client";

import {
  accountHandle, rethrowAccountChanged, accountFetch, accountJson, type AccountHandle,
} from "@/lib/device/account";
import { PREFERENCE_FLAGS, type PreferenceFlag } from "./onboarding-state";
import { localDietSuggestion } from "./local-diet-flags";
import { localOffer, type TasteSuggestion } from "./taste-chips";
import { tasteTextRoute } from "./taste-safety";

export type PrefsResponse = {
  flags: Partial<Record<PreferenceFlag | "no_nuts", number>>;
  mentionsFoods: number;
  /**
   * True when `flags` (and `cookingEffortSuggestion`) are a classifier answer for the field to apply:
   * Jev's, or — for text the safety check keeps from any model — the phone's own keyword suggester
   * (`source: "local"`, lib/profile/local-diet-flags.ts; no model was called).
   */
  jev: boolean;
  cookingEffortSuggestion?: "none" | "minimal" | "full" | null;
  source?: "jev" | "local";
  /** Phase 18 W5b: "local" when the safety check kept the text on the phone (no Jev call). */
  route?: "local" | "send";
  reason?: "rules" | "symptom" | "unsure";
  offer?: "rule_editor" | "plain_prefs";
};

export function suggestedPreferenceFlags(
  flags: Partial<Record<PreferenceFlag | "no_nuts", number>>,
): PreferenceFlag[] {
  return PREFERENCE_FLAGS.filter((flag) => {
    const confidence = flag === "no_peanuts"
      ? Math.max(flags.no_peanuts ?? 0, flags.no_nuts ?? 0)
      : flags[flag] ?? 0;
    return confidence >= 0.8;
  });
}

export async function classifyDietaryPreferences(
  text: string,
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<PrefsResponse | null> {
  if (!text.trim()) return { flags: {}, mentionsFoods: 0, jev: false };
  // The local check runs on the phone first: kept text is never sent to Jev or any model (D9 item 3).
  // (The field's raw text is still saved to the user's own account, diet_prefs.text, as on main.)
  const route = tasteTextRoute(text);
  if (route.route === "local") {
    // Kept text makes no classifier request; the phone suggests the same flags from keywords instead
    // (none for medical or symptom text — the field offers the rule editor).
    const local = localDietSuggestion(text, route.reason);
    const any = Object.keys(local.flags).length > 0 || local.cookingEffort !== null;
    return { flags: local.flags, mentionsFoods: 0, jev: any, cookingEffortSuggestion: local.cookingEffort,
      source: "local", route: "local", reason: route.reason, offer: localOffer(route.reason) };
  }
  const h = opts.account ?? accountHandle();
  try {
    const response = await accountFetch(h, "/api/profile/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }, { budget: "prefs", fetchImpl: opts.fetchImpl });
    if (!response.ok) return null;
    return await accountJson<PrefsResponse>(h, response);
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}

export type PreferenceClassifier = {
  run: (text: string) => Promise<void>;
};

/** Keeps only the newest Jev response when preference requests overlap. */
export function createPreferenceClassifier(
  apply: (flags: PreferenceFlag[]) => void,
  setBusy: (busy: boolean) => void,
  classify: (text: string) => Promise<PrefsResponse | null> = classifyDietaryPreferences,
): PreferenceClassifier {
  let latestSequence = 0;
  return {
    async run(text: string): Promise<void> {
      const sequence = ++latestSequence;
      setBusy(true);
      try {
        const result = await classify(text);
        if (sequence !== latestSequence || !result?.jev) return;
        apply(suggestedPreferenceFlags(result.flags));
      } finally {
        if (sequence === latestSequence) setBusy(false);
      }
    },
  };
}

/**
 * Phase 18 W5b-3: the answer to one taste text, with "off" kept apart from "failed".
 *
 *   ok        the suggestion: the local route for kept text (no request made), or the server's chips
 *   disabled  404 `not_enabled`: `TASTE_CHIPS_ENABLED` is off. Not transient — hide the field.
 *   failed    anything else: offline, a timeout, another status (`status` when one came back),
 *             another shape. Transient as far as the phone knows; continue with manual chips.
 */
export type TasteChipsAnswer =
  | { ok: true; suggestion: TasteSuggestion }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "failed"; status?: number };

const LOCAL_REASONS: readonly unknown[] = ["rules", "symptom", "unsure"];
const LOCAL_OFFERS: readonly unknown[] = ["rule_editor", "plain_prefs"];

function isChipList(value: unknown): boolean {
  return Array.isArray(value) && value.every((chip: unknown) => {
    if (typeof chip !== "object" || chip === null) return false;
    const c = chip as Record<string, unknown>;
    return typeof c.key === "string" && typeof c.label === "string"
      && typeof c.p === "number" && Number.isFinite(c.p) && c.p >= 0 && c.p <= 1;
  });
}

/** The shape of the server's answer only; the chip keys are re-checked by the confirm route. */
function isTasteSuggestion(value: unknown): value is TasteSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.route === "local") return LOCAL_REASONS.includes(v.reason) && LOCAL_OFFERS.includes(v.offer);
  return v.route === "send" && typeof v.jev === "boolean"
    && isChipList(v.likes) && isChipList(v.dislikes) && isChipList(v.cuisines);
}

/**
 * Phase 18 W5b: chips for the optional taste text. The local safety check runs HERE first: text it
 * keeps (a rule, a symptom, anything unsure) is never sent to Jev or any model and answers the local
 * route at once. Sent text answers the server's suggestion, `disabled` for the switch being off, or
 * `failed`. Nothing is written; the caller confirms.
 */
export async function requestTasteChips(
  text: string,
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<TasteChipsAnswer> {
  const route = tasteTextRoute(text);
  if (route.route === "local") {
    return { ok: true, suggestion: { route: "local", reason: route.reason, offer: localOffer(route.reason) } };
  }
  const h = opts.account ?? accountHandle();
  let response: Response;
  try {
    response = await accountFetch(h, "/api/profile/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taste: text }),
    }, { budget: "prefs", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "failed" };
  }
  let body: unknown;
  try {
    body = await accountJson<unknown>(h, response);
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "failed", status: response.status };
  }
  if (!response.ok) {
    const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    // Only the route's own 404 `not_enabled` means off; a bare 404 (no such route, a proxy page) does not.
    if (response.status === 404 && code === "not_enabled") return { ok: false, reason: "disabled" };
    return { ok: false, reason: "failed", status: response.status };
  }
  return isTasteSuggestion(body) ? { ok: true, suggestion: body } : { ok: false, reason: "failed", status: response.status };
}

/**
 * The W5b shape of `requestTasteChips`: the suggestion, or null for `disabled` and `failed` alike
 * (the flow then continues with manual chips, as it does for `jev: false`). Kept for callers that
 * do not need the difference; new callers use `requestTasteChips`.
 */
export async function suggestTasteChips(
  text: string,
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<TasteSuggestion | null> {
  const answer = await requestTasteChips(text, opts);
  return answer.ok ? answer.suggestion : null;
}
