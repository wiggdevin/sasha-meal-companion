/**
 * UI-NEEDS SPROUT-CARE (coord.md 2026-10-07T04:15Z): request/response shapes for the Seeds
 * ledger, shop, accolades, messages and log-growth routes under app/api/care/. Kept separate from
 * the UI's own presentation types (components/today/care/shop/catalog.ts) -- this file is the
 * wire contract the routes validate against; that file is what Sprout's scene renders.
 */
import { z } from "zod";

export const CARE_SLOTS = ["head", "eyes", "hands", "legs", "pin", "body", "prop", "scene", "care"] as const;
export type CareSlot = (typeof CARE_SLOTS)[number];

export const CARE_LEDGER_KINDS = ["day_recorded", "day_complete", "protein_goal", "water_goal",
  "five_day_week", "weigh_in_week", "purchase", "reversal"] as const;
export type CareLedgerKind = (typeof CARE_LEDGER_KINDS)[number];

export type CareLedgerRow = {
  id: string; kind: CareLedgerKind; delta: number; localDate: string;
  status: "pending" | "settled" | "reversed";
  itemId?: string | null;
};
export type CarePointsResponse = { balance: number; pending: number; recent: CareLedgerRow[] };

export type CareShopItem = {
  id: string; slot: CareSlot; tier: "wearable" | "prop" | "scene" | "care"; price: number;
  assetKey: string; mascots: string[];
};
export type CareShopResponse = {
  items: CareShopItem[]; owned: string[]; equipped: Partial<Record<CareSlot, string>>;
  /** shop-state.ts's `ShopState.rev`: the optimistic-concurrency token POST /api/care/equip needs. */
  rev: number;
  balance: number;
};

export const carePurchaseRequestSchema = z.object({
  itemId: z.string().min(1).max(40),
  actionId: z.uuid(),
});
export type CarePurchaseRequest = z.infer<typeof carePurchaseRequestSchema>;
export type CarePurchaseReceipt = { actionId: string; itemId: string; price: number; balance: number };
export type CarePurchaseResult =
  | { status: "applied" | "existing"; receipt: CarePurchaseReceipt }
  | { status: "unknown_item" | "owned" | "action_conflict" }
  | { status: "insufficient"; short: number };

export const careEquipRequestSchema = z.object({
  slot: z.enum(CARE_SLOTS),
  itemId: z.string().min(1).max(40).nullable(),
  rev: z.number().int().min(0).nullable().optional(),
});
export type CareEquipRequest = z.infer<typeof careEquipRequestSchema>;
export type CareEquipResult = {
  status: "ok" | "conflict" | "not_owned" | "wrong_slot";
  equipped: Partial<Record<CareSlot, string>>; rev: number;
};

export const CARE_ACCOLADE_KEYS = ["first-meal", "first-complete-day", "full-week", "seven-days",
  "thirty-days", "goal-5", "goal-20", "protein-5", "water-5", "workout-pair", "workout-10",
  "first-note", "first-recipe", "welcome-back", "weight-milestone"] as const;
export type CareAccoladeKey = (typeof CARE_ACCOLADE_KEYS)[number];
export type CareAccolade = {
  key: CareAccoladeKey; version: number; earnedAt: string; evidence: unknown; seenAt: string | null;
};

export const careAccoladesSeenRequestSchema = z.object({
  keys: z.array(z.enum(CARE_ACCOLADE_KEYS)).min(1).max(50),
});

export const CARE_MESSAGE_TYPES = ["tip", "accolade", "observation", "system", "shop", "streak"] as const;
export type CareMessageType = (typeof CARE_MESSAGE_TYPES)[number];
export type CareMessage = {
  id: string; type: CareMessageType; payload: unknown; createdAt: string;
  readAt: string | null; dismissedAt: string | null;
};

export const careLogGrowthQuerySchema = z.object({ opId: z.uuid() });
export type CareLogGrowthResult = { opId: string; kind: string | null; localDate: string | null; grew: boolean };
