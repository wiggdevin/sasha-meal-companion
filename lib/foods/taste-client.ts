"use client";

/**
 * Client reader for `GET /api/foods/taste` (lib/server/taste-admission.ts, Phase 18 W3): the
 * account's own eaten history, for the Foods tab's read-only "Eaten often" section
 * (components/EatenOften.tsx).
 *
 * This module trusts nothing a fetch returns — the answer is validated at the boundary. A single
 * malformed item is dropped rather than crashing the section; the whole answer is `unavailable`
 * only when the envelope itself (the version, the items array) cannot be read, or the request
 * failed outright (offline, a timeout, a non-2xx status, an account switch mid-flight). Order is
 * the server's own — highest H first — and is never re-sorted here.
 */
import { accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { targetDayFor } from "@/lib/targets/revision";

const TASTE_VERSION = "taste-1";
/** The wire contract's own closed sets (lib/meals/taste.ts TASTE_SOURCES / CHOICE_KINDS) — kept
 *  local rather than imported, so this boundary validates the WIRE shape, not whatever the
 *  server's own arithmetic module happens to export today. */
const TASTE_SOURCES = ["log", "recipe", "tick", "mixed_dish"] as const;
const CHOICE_KINDS = ["swap_pick", "plan_add", "shopping_manual"] as const;

export type TasteSource = (typeof TASTE_SOURCES)[number];
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

export type TasteRowProvenance = {
  match: "universe" | "family";
  estimated: boolean;
  sources: Record<TasteSource, number>;
  collapsed: number;
  choices: Record<ChoiceKind, number>;
};

/** One admitted food, as the Foods tab's "Eaten often" section draws it. */
export type TasteRow = {
  key: string;
  name: string;
  days180: number;
  lastOn: string;
  favored: boolean;
  /** True only when `POST /api/foods/favor` would succeed for this key now (the server's own Favor
   *  plan); an older answer without the field reads as false, so no button is offered. */
  favorable: boolean;
  h: number;
  q: number;
  provenance: TasteRowProvenance;
};

export type TasteRead =
  | { status: "ok"; items: readonly TasteRow[] }
  | { status: "rule_review"; message: string }
  | { status: "unavailable" };

/**
 * The same sentence `GET /api/foods/eligible`'s 409 already shows elsewhere on this tab: both
 * lib/server/eligible-foods.ts and lib/server/taste-admission.ts throw this exact copy, and
 * components/RecipeDiscovery.tsx shows a sibling read's own version of it the same way (its error
 * message, surfaced through a Notice). Written here rather than read off the response so the copy
 * stays stable even if a future server answer phrases its `message` differently.
 */
export const TASTE_RULE_REVIEW_COPY =
  "Review your existing food rules in Settings before getting meal suggestions.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every key in `keys` maps to a finite number; nothing else about the object is required. */
function validCounts<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, number> {
  return isRecord(value) && keys.every((key) => finite(value[key]));
}

function validRow(value: unknown): value is Omit<TasteRow, "favorable"> & { favorable?: boolean } {
  if (!isRecord(value)) return false;
  if (typeof value.key !== "string" || typeof value.name !== "string") return false;
  if (!finite(value.days180) || value.days180 < 0) return false;
  if (typeof value.lastOn !== "string" || !LOCAL_DATE.test(value.lastOn)) return false;
  if (typeof value.favored !== "boolean") return false;
  if (value.favorable !== undefined && typeof value.favorable !== "boolean") return false;
  if (!finite(value.h) || !finite(value.q)) return false;
  const provenance = value.provenance;
  if (!isRecord(provenance)) return false;
  if (provenance.match !== "universe" && provenance.match !== "family") return false;
  if (typeof provenance.estimated !== "boolean") return false;
  if (!finite(provenance.collapsed)) return false;
  if (!validCounts(provenance.sources, TASTE_SOURCES)) return false;
  if (!validCounts(provenance.choices, CHOICE_KINDS)) return false;
  return true;
}

/**
 * Up to 50 rows, in the server's own order (highest H first) — never re-sorted here. `date`
 * defaults to the phone's own local day (targetDayFor), the same rule every other dated read on
 * this phone follows (lib/targets/revision.ts).
 */
export async function loadTaste(
  opts: { account?: AccountHandle; fetchImpl?: typeof fetch } = {},
): Promise<TasteRead> {
  try {
    const account = opts.account ?? accountHandle();
    const res = await accountFetch(account, `/api/foods/taste?date=${targetDayFor()}`,
      { cache: "no-store" }, { budget: "search", fetchImpl: opts.fetchImpl });
    if (res.status === 409) {
      const body = await accountJson<{ error?: unknown }>(account, res).catch(() => null);
      return body?.error === "rule_review_required"
        ? { status: "rule_review", message: TASTE_RULE_REVIEW_COPY }
        : { status: "unavailable" };
    }
    if (!res.ok) return { status: "unavailable" };
    const body = await accountJson<unknown>(account, res);
    if (!isRecord(body) || body.version !== TASTE_VERSION || !Array.isArray(body.items)) {
      return { status: "unavailable" };
    }
    return { status: "ok", items: body.items.filter(validRow)
      .map((item) => ({ ...item, favorable: item.favorable === true })) };
  } catch {
    // Offline, a timeout (lib/fetch-with-deadline.ts), a non-JSON body, or the account changing
    // mid-flight (AccountChanged) are all the same fact to this read-only section: nothing new to
    // show. The caller never acts on a result for an account that is no longer current.
    return { status: "unavailable" };
  }
}
