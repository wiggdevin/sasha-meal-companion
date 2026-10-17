/**
 * The one canonical commit contract — Phase 2 spec, "API changes". It supersedes
 * phase-4-ai-capture.md's camelCase CommitRequest: every field in log_entries is snake_case on
 * the wire, matching the Phase 0 sync envelope, and Phase 4's calls travel this same shape.
 *
 * Shared by client and server: the browser builds a request here, the server validates the same
 * schema in `applyLogEntry` (`lib/server/log.ts`; its label-food half is `lib/server/log-label-food.ts`
 * and its day totals are `lib/server/day-totals.ts`), and the outbox derives the same op_id so an
 * offline replay and an online retry collapse onto one change_log row.
 *
 * Pure. No I/O, no Supabase import.
 */

import { z } from "zod";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import type { NutrientTotal } from "@/lib/nutrients/totals";
import type { SlotId } from "@/lib/types";

const SLOT_IDS = ["coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3",
  "meal-4",
  "meal-5",
  "meal-6",
  "hot-chocolate"] as const satisfies readonly SlotId[];
/**
 * What a COMMIT may name. `snack` is not a plan slot and never will be: it is the label an entry
 * that belongs to no slot carries (T6 §3). `log_entries.slot` is a free-text column and nothing
 * resolves an entry's slot back to a plan slot — the Today stack orders extras by `eaten_at` —
 * so the label costs nothing and tells the export and the coach what the entry was.
 */
const COMMIT_SLOT_IDS = [...SLOT_IDS, "snack"] as const;
const METHODS = ["search", "plan", "text", "voice", "label", "photo", "barcode"] as const;
const DRAFT_METHODS: readonly string[] = ["voice", "label", "photo"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `grams` null: the mass is unknown (t17 gap 1, migration 20261211090000) — a unit of a food with
 * no known unit weight. `qty` and `unit` are then the whole amount, no catalog revision or portion
 * may be named, and `per_unit` (nutrient code → amount in ONE unit, the account's own numbers)
 * is what the server multiplies by `qty`. With no `per_unit` the item's nutrients are unknown.
 */
export type LogItemInput = {
  id: string; seq: number; food_ref_id: string;
  qty: number; unit: string; grams: number | null;
  per_unit?: Record<string, number> | null;
  portion_id?: number | null; food_revision_id?: number | null; was_edited?: boolean;
  confidence?: number;
};

/**
 * The label a `save_label_as_food` commit saves as the account's own food. Not part of the parsed
 * schema: the route hands the raw body's `label_food` to lib/server/log-label-food.ts, which
 * validates it, and a queued commit carries it in its op payload for /api/sync/ops (A030).
 */
export type LabelFoodWire = {
  name: string; brand?: string; per100g: Record<string, number | null>;
  ingredientsText?: string; allergenTags: string[];
};

export type LogCommitRequest = {
  entry_id: string; base_rev?: number;
  eaten_at: string; tz: string; local_date: string; slot: SlotId | "snack";
  method: (typeof METHODS)[number];
  draft_id?: string; save_label_as_food?: boolean; label_food?: LabelFoodWire;
  /**
   * A plate photo's kept 512 px copy (W125, T2 D2): one of the caller's own media paths. Not part
   * of the parsed schema, like `label_food`: the route hands the raw value to lib/server/log.ts,
   * which links it to the entry only after an applied write.
   */
  thumbnail_path?: string;
  /** Storage allows 80 characters so user-authored titles have headroom beyond coach titles. */
  title?: string | null;
  note?: string; items: LogItemInput[];
};

export type DayTotals = {
  local_date: string; nutrients: NutrientTotal[]; micro_coverage_pct: number;
};

/** The full log_entries row with items[] inline, exactly as _sync_current returns it. */
export type LogEntity = Record<string, unknown>;

export type LogCommitResponse = {
  status: "ok"; entry_id: string; rev: number; user_food_id?: string;
  /**
   * The stored items, whole — the client mirrors them verbatim, and a row whose items name no
   * food cannot be the base of an edit (T0 §3, Grok pass 3 HIGH 2).
   */
  items: {
    id: string; entry_id: string; seq: number; food_ref_id: string;
    /** null: the mass is unknown (see `LogItemInput`). Never read as 0. */
    qty: number; unit: string; grams: number | null;
    portion_id: number | null; food_revision_id: number | null;
    was_edited: boolean; confidence: number | null;
    snapshot: Snapshot;
    /**
     * Recorded at write time (20261210090400): true for a serving of a partly measured recipe,
     * false for a fully measured one, null for anything else or a row written before then.
     */
    nutrition_partial?: boolean | null;
  }[];
  totals: DayTotals;
  /**
   * Items the constraint policy blocked (`blocked:...`), or left unverified for an allergen a
   * label check would resolve (`unverified:allergen:...` — §9 R1's "shows a 'Check the label'
   * mark" requirement). The entry is still recorded — the log marks, it never refuses
   * (docs/decisions/2026-09-14-logging-marks-never-refuses.md) — and this is what the app shows
   * the mark from. Absent when nothing was flagged.
   */
  flagged?: { path: string; message: string }[];
  /**
   * Items logged from a saved recipe whose per-serving nutrition is only partly measured
   * (`coverage` < 1, calculation audit #21): their kcal and macros sum the measured ingredients
   * only. The entry is still recorded; the app marks it partial. Absent when every item is whole.
   * `source`: "recorded" (the item's own write-time flag), "derived" (no recorded flag; judged
   * from the recipe's current revision, approximate) or "unchecked" (that fallback could not be
   * read, so the item is marked rather than passed). `coverage` only on a derived mark.
   */
  partial_nutrition?: { path: string; item_id: string | null; seq: number | null;
    food_ref_id: string; coverage: number | null; source: "recorded" | "derived" | "unchecked" }[];
  /**
   * The partial check itself could not run for this entry (its food refs were unreadable), so no
   * item could be told apart from a catalog food. Nothing is called partial; the entry's
   * nutrition is "not fully checked". Absent on a normal answer.
   */
  nutrition_unchecked?: true;
};

export type LogCommitFailure =
  | { status: "conflict"; current_rev: number; entity: LogEntity }
  | { status: "deleted"; deleted_at: string }
  | { status: "gone" }
  | { status: "stale_revision"; food_ref_id: string; revision_id: number }
  | { status: "invalid"; issues: { path: string; message: string }[] };

const NUTRIENT_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const logItemInputSchema: z.ZodType<LogItemInput> = z.object({
  id: z.string().regex(UUID, "must be a uuid"),
  seq: z.number().int().min(0),
  food_ref_id: z.string().regex(UUID, "must be a uuid"),
  qty: z.number().gt(0, "must be greater than 0"),
  unit: z.string().min(1).max(32),
  grams: z.number().gt(0, "must be greater than 0").nullable(),
  per_unit: z.record(z.string().regex(NUTRIENT_KEY, "must be a nutrient code"),
    z.number().finite().min(0)).nullish(),
  portion_id: z.number().int().nullish(),
  food_revision_id: z.number().int().nullish(),
  was_edited: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).superRefine((item, ctx) => {
  if (item.grams === null) {
    // An unknown mass is a count of the food's own units, nothing else: a catalog revision or
    // portion always knows its grams.
    if (item.food_revision_id != null) {
      ctx.addIssue({ code: "custom", path: ["food_revision_id"],
        message: "an item with unknown grams names no catalog revision" });
    }
    if (item.portion_id != null) {
      ctx.addIssue({ code: "custom", path: ["portion_id"],
        message: "an item with unknown grams names no portion" });
    }
    if (item.unit === "g") {
      ctx.addIssue({ code: "custom", path: ["unit"], message: "grams of unknown mass is not a unit" });
    }
  } else if (item.per_unit != null) {
    ctx.addIssue({ code: "custom", path: ["per_unit"],
      message: "per_unit is only sent with unknown grams" });
  }
  if (item.per_unit != null && Object.keys(item.per_unit).length > 60) {
    ctx.addIssue({ code: "custom", path: ["per_unit"], message: "too many nutrients" });
  }
}) as z.ZodType<LogItemInput>;

/**
 * The half of the unknown-mass rule the schema cannot see (t17 round 3): `grams: null` and
 * `per_unit` belong only to the account's OWN food (`food_refs.kind = 'user'`). A catalog ref
 * always has a mass and its own numbers; per_unit on it would let a request state any calories.
 * `kindOf` answers a ref's kind (undefined when unknown, which is refused too). The SQL twin is
 * the `log_items_unknown_mass_own_food` trigger (migration 20261211090000).
 */
export function unknownMassRefIssues(
  items: readonly LogItemInput[], kindOf: (refId: string) => string | undefined,
): { path: string; message: string }[] {
  return items.flatMap((item, index) => (item.grams === null && kindOf(item.food_ref_id) !== "user"
    ? [{ path: `items.${index}.grams`,
      message: "an unknown mass is only for the account's own food, never a catalog food" }]
    : []));
}

/** The calendar day `eatenAt` fell on in `tz`; null when the zone is unknown. */
export function localDateFor(eatenAt: string, tz: string): string | null {
  const at = new Date(eatenAt);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
      day: "2-digit" }).format(at);
  } catch {
    return null;
  }
}

export const logCommitRequestSchema: z.ZodType<LogCommitRequest> = z
  .object({
    entry_id: z.string().regex(UUID, "must be a uuid"),
    base_rev: z.number().int().min(1).optional(),
    eaten_at: z.string().regex(ISO_INSTANT, "must be an ISO 8601 instant with an offset"),
    tz: z.string().min(1).max(64),
    local_date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
    slot: z.enum(COMMIT_SLOT_IDS),
    method: z.enum(METHODS),
    draft_id: z.string().regex(UUID, "must be a uuid").optional(),
    save_label_as_food: z.boolean().optional(),
    title: z.string().trim().min(1, "must not be empty")
      .max(80, "must be 80 characters or fewer").nullable().optional(),
    note: z.string().max(2000).optional(),
    items: z.array(logItemInputSchema).min(1).max(30),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    for (const item of value.items) {
      if (seen.has(item.seq)) {
        ctx.addIssue({ code: "custom", path: ["items"],
          message: "seq must be unique within an entry" });
        break;
      }
      seen.add(item.seq);
    }
    const resolved = localDateFor(value.eaten_at, value.tz);
    if (resolved === null) {
      ctx.addIssue({ code: "custom", path: ["tz"], message: "unknown time zone" });
    } else if (resolved !== value.local_date) {
      ctx.addIssue({ code: "custom", path: ["local_date"],
        message: "local_date does not match eaten_at in tz" });
    }
    if (DRAFT_METHODS.includes(value.method) && !value.draft_id) {
      ctx.addIssue({ code: "custom", path: ["draft_id"],
        message: `method '${value.method}' needs a draft_id` });
    }
    if (value.save_label_as_food && value.method !== "label") {
      ctx.addIssue({ code: "custom", path: ["save_label_as_food"],
        message: "save_label_as_food needs method 'label'" });
    }
  }) as z.ZodType<LogCommitRequest>;

export function issuesFrom(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * The op id lives in lib/log/op-id.ts, which has no `node:` import: this contract is shared by the
 * browser and the server, and a `node:crypto` in it followed the client into the bundle.
 */
export { opIdFor } from "@/lib/log/op-id";
