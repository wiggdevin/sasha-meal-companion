import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { CaptureDraft, UiBlock } from "@/lib/coach/ui-blocks";
import { foodKey, inputHash, type FacetFoodInput } from "@/lib/foods/facet-keys";
import type {
  CheckSanity, DeterministicSanity, SanityAnnotation, SanityDraft, SanityResult, TypicalServing,
} from "@/lib/log/sanity-types";

type ToolCalls = Record<string, unknown> & {
  actions?: CoachAction[];
  blocks?: UiBlock[];
};

type SanityItem = {
  itemId: string;
  name: string;
  brand?: string | null;
  description?: string | null;
  preparation?: string | null;
  ingredientsText?: string | null;
  grams: number | null;
  kcalPer100g?: number | null;
  catalogFoodRevisionId?: number | null;
};

export type CoachSanityRun = {
  toolCalls: ToolCalls;
  actions: CoachAction[];
  settled: Promise<ToolCalls>;
};

type SanityDeps = {
  check: CheckSanity;
  schedule?: (task: () => Promise<void>) => void;
};

type DeterministicDeps = {
  deterministic: DeterministicSanity;
  typical?: (portions: readonly {
    id: string | number; description: string; gramWeight: number; isDefault: boolean;
  }[]) => { grams: number; label: string } | null;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Only item-owned food fields cross the sanity boundary; caller state is not accepted here. */
export function sanityDraftFromItem(item: SanityItem): SanityDraft {
  const food: FacetFoodInput = {
    name: item.name,
    ...(text(item.brand) ? { brand: text(item.brand) } : {}),
    ...(text(item.description) ? { description: text(item.description) } : {}),
    ...(text(item.preparation) ? { preparation: text(item.preparation) } : {}),
    ...(text(item.ingredientsText) ? { ingredientsText: text(item.ingredientsText) } : {}),
  };
  const gramsPerServing = finite(item.grams) ? item.grams : null;
  const kcalPer100g = finite(item.kcalPer100g) ? item.kcalPer100g : null;
  const revisionId = item.catalogFoodRevisionId;
  return {
    itemId: item.itemId,
    food,
    amounts: {
      gramsPerServing,
      kcalPerServing: gramsPerServing !== null && kcalPer100g !== null
        ? gramsPerServing * kcalPer100g / 100 : null,
    },
    ...(Number.isSafeInteger(revisionId) && Number(revisionId) > 0 ? { facetKey: {
      foodKey: foodKey({ kind: "catalog_revision", id: Number(revisionId) }),
      inputHash: inputHash(food),
    } } : {}),
  };
}

function annotation(result: SanityResult): SanityAnnotation {
  return { status: result.sanityStatus, warnings: result.warnings };
}

function energy(per100g: Record<string, number | null> | undefined): number | null {
  const value = per100g?.energy_kcal ?? per100g?.energy_kcal_calc;
  return finite(value) ? value : null;
}

function barcodeItem(
  draft: Extract<CaptureDraft, { status: "resolved" }>,
  typical?: TypicalServing,
): SanityItem {
  const match = draft.match;
  return {
    itemId: match.foodRefId,
    name: match.description,
    brand: match.brand,
    ingredientsText: match.ingredientsText,
    grams: typical?.grams ?? null,
    kcalPer100g: energy(match.per100g),
    catalogFoodRevisionId: match.revisionId,
  };
}

function barcodeServing(
  draft: Extract<CaptureDraft, { status: "resolved" }>,
  typical?: DeterministicDeps["typical"],
): TypicalServing | undefined {
  const suggested = typical?.(draft.match.portions);
  if (suggested && finite(suggested.grams) && suggested.grams > 0 && text(suggested.label)) {
    return { grams: suggested.grams, label: suggested.label.trim() };
  }
  const first = draft.match.portions.find((portion) =>
    finite(portion.gramWeight) && portion.gramWeight > 0 && text(portion.description));
  return first ? { grams: first.gramWeight, label: first.description.trim() } : undefined;
}

function captureItem(
  draft: Exclude<CaptureDraft, { status: "resolved" }>,
  item: Exclude<CaptureDraft, { status: "resolved" }>["items"][number],
): SanityItem {
  const label = draft.labelFood;
  return {
    itemId: String(item.seq),
    name: item.label,
    ...(label ? {
      brand: label.brand,
      ingredientsText: label.ingredientsText,
      kcalPer100g: energy(label.per100g),
    } : {}),
    grams: item.grams,
    catalogFoodRevisionId: item.catalogFoodRevisionId,
  };
}

function captureServing(
  draft: Exclude<CaptureDraft, { status: "resolved" }>,
  item: Exclude<CaptureDraft, { status: "resolved" }>["items"][number],
): TypicalServing | undefined {
  if (draft.method !== "photo" && draft.method !== "label") return undefined;
  if (!finite(item.qty) || item.qty <= 0 || !finite(item.grams) || item.grams <= 0) return undefined;
  const label = text(item.unit);
  const isLabelSuggestion = draft.labelFood !== undefined && !/^(?:g|gram|grams|ml)$/i.test(label ?? "");
  if (item.portionId === null && !isLabelSuggestion) return undefined;
  return label ? { grams: item.grams / item.qty, label } : undefined;
}

function actionItem(actionId: string, item: GroundedActionItem, index: number): SanityItem {
  return {
    itemId: `${actionId}:${index}`,
    name: item.name,
    grams: item.grams,
    kcalPer100g: item.kcalPer100g,
    catalogFoodRevisionId: item.catalogFoodRevisionId,
  };
}

export function attachDeterministicSanity<T extends CaptureDraft>(
  draft: T,
  deps: DeterministicDeps,
): T {
  if ("status" in draft) {
    const suggestion = barcodeServing(draft, deps.typical);
    const sanity = annotation(deps.deterministic(sanityDraftFromItem(
      barcodeItem(draft, suggestion),
    )));
    return { ...draft, match: {
      ...draft.match,
      sanity,
      ...(suggestion ? { typicalServing: suggestion } : {}),
    } } as T;
  }
  return { ...draft, items: draft.items.map((item) => {
    const suggestion = captureServing(draft, item);
    return {
      ...item,
      sanity: annotation(deps.deterministic(sanityDraftFromItem(captureItem(draft, item)))),
      ...(suggestion ? { typicalServing: suggestion } : {}),
    };
  }) } as T;
}

function deterministicAction(
  action: CoachAction,
  deterministic: (draft: SanityDraft) => SanityResult,
): CoachAction {
  if (action.kind !== "log_meal") return action;
  return { ...action, items: action.items.map((item, index) => ({
    ...item,
    sanity: annotation(deterministic(sanityDraftFromItem(actionItem(action.actionId, item, index)))),
  })) };
}

function deterministicBlock(
  block: UiBlock,
  deps: DeterministicDeps,
): UiBlock {
  return block.kind === "log_draft"
    ? { ...block, draft: attachDeterministicSanity(block.draft, deps) }
    : block;
}

export function attachDeterministicCoachSanity(
  value: unknown,
  deps: DeterministicDeps,
): ToolCalls {
  const toolCalls = value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as ToolCalls : {};
  return {
    ...toolCalls,
    ...(toolCalls.actions ? {
      actions: toolCalls.actions.map((action) => deterministicAction(action, deps.deterministic)),
    } : {}),
    ...(toolCalls.blocks ? {
      blocks: toolCalls.blocks.map((block) => deterministicBlock(block, deps)),
    } : {}),
  };
}

async function checkedDraft(
  draft: CaptureDraft,
  checkOnce: (draft: SanityDraft, current?: SanityAnnotation) => Promise<SanityAnnotation>,
): Promise<CaptureDraft> {
  if ("status" in draft) {
    return { ...draft, match: {
      ...draft.match,
      sanity: await checkOnce(
        sanityDraftFromItem(barcodeItem(draft, draft.match.typicalServing)), draft.match.sanity,
      ),
    } };
  }
  const items = await Promise.all(draft.items.map(async (item) => ({
    ...item,
    sanity: await checkOnce(sanityDraftFromItem(captureItem(draft, item)), item.sanity),
  })));
  return { ...draft, items };
}

async function checkedAction(
  action: CoachAction,
  checkOnce: (draft: SanityDraft, current?: SanityAnnotation) => Promise<SanityAnnotation>,
): Promise<CoachAction> {
  if (action.kind !== "log_meal") return action;
  const items = await Promise.all(action.items.map(async (item, index) => ({
    ...item,
    sanity: await checkOnce(
      sanityDraftFromItem(actionItem(action.actionId, item, index)), item.sanity,
    ),
  })));
  return { ...action, items };
}

async function checkedToolCalls(
  toolCalls: ToolCalls,
  check: CheckSanity,
  options: { signal: AbortSignal; userId: string },
): Promise<ToolCalls> {
  let spent = false;
  const checkOnce = async (
    draft: SanityDraft,
    current?: SanityAnnotation,
  ): Promise<SanityAnnotation> => {
    if (current?.status !== "pending") {
      return current ?? { status: "unknown", warnings: [] };
    }
    if (spent) return { status: "unknown", warnings: [] };
    spent = true;
    return annotation(await check(draft, options));
  };
  return {
    ...toolCalls,
    ...(toolCalls.actions ? {
      actions: await Promise.all(toolCalls.actions.map((action) =>
        checkedAction(action, checkOnce))),
    } : {}),
    ...(toolCalls.blocks ? {
      blocks: await Promise.all(toolCalls.blocks.map(async (block): Promise<UiBlock> =>
        block.kind === "log_draft"
          ? { ...block, draft: await checkedDraft(block.draft, checkOnce) }
          : block)),
    } : {}),
  };
}

export function hasCoachSanityTargets(value: unknown): boolean {
  const toolCalls = value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as ToolCalls : {};
  return toolCalls.actions?.some((action) => action.kind === "log_meal") === true
    || toolCalls.blocks?.some((block) => block.kind === "log_draft") === true;
}

async function writeBack(
  client: SupabaseClient,
  userId: string,
  messageId: string,
  toolCalls: ToolCalls,
): Promise<void> {
  try {
    const { error } = await client.from("coach_messages").update({ tool_calls: toolCalls })
      .eq("id", messageId).eq("user_id", userId);
    if (error) console.error("coach sanity write-back failed", { error: error.message.slice(0, 200) });
  } catch (error) {
    console.error("coach sanity write-back failed", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
    });
  }
}

function afterResponse<T>(task: () => Promise<T>, schedule?: SanityDeps["schedule"]): Promise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const settled = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  const run = async () => {
    try {
      resolve(await task());
    } catch (error) {
      reject(error);
    }
  };
  try {
    (schedule ?? ((callback) => queueMicrotask(() => void callback())))(run);
  } catch {
    // Unit tests call the server entry without a Next request context. Production uses `after`.
    queueMicrotask(() => void run());
  }
  return settled;
}

/**
 * Starts only after the assistant row exists and already carries deterministic annotations.
 * Provider work and its row patch are fail-open and never sit on the logging/apply path.
 */
export function startPersistedCoachSanity(
  client: SupabaseClient,
  userId: string,
  messageId: string,
  value: unknown,
  signal: AbortSignal,
  deps: SanityDeps,
): CoachSanityRun {
  const toolCalls = value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as ToolCalls : {};
  if (!hasCoachSanityTargets(toolCalls)) {
    return { toolCalls, actions: toolCalls.actions ?? [], settled: Promise.resolve(toolCalls) };
  }
  const settle = async () => {
    const checked = await checkedToolCalls(toolCalls, deps.check, { signal, userId });
    await writeBack(client, userId, messageId, checked);
    return checked;
  };
  const settled = afterResponse(settle, deps.schedule).catch((error: unknown) => {
    console.error("coach sanity failed open", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
    });
    return toolCalls;
  });
  return { toolCalls, actions: toolCalls.actions ?? [], settled };
}
