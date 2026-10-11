import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import type { BarcodeMatch } from "@/lib/barcode/client";
import type { CoachAttachment } from "@/lib/coach/attachments";
import { toMessageView, type CoachMessageView } from "@/lib/coach/message-view";
import { AFTER_RESPONSE_BUDGET_MS } from "@/lib/coach/turn";
import { captureDraftSchema, type LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import type { CoachTurnRequest, CoachTurnResponse } from "@/lib/coach/types";
import { completenessText } from "@/lib/foods/catalog-ingredients";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { assertChatCapacity, INCOMPLETE_TURN_REPLY, INCOMPLETE_TURN_WINDOW_MS,
  nextSeq, persist, resolveThread,
  type MessageRow } from "@/lib/server/coach-threads";
import { deterministicSanity } from "@/lib/log/sanity-deterministic";
import { typicalServingSuggestion } from "@/lib/log/serving-identity";
import { attachDeterministicSanity, startPersistedCoachSanity }
  from "@/lib/server/coach-sanity";
import { proposeDraft } from "@/lib/server/capture";
import { accountClock } from "@/lib/server/day-context";
import { HttpError } from "@/lib/server/auth";
import { mergeScannedAllergenFacts, policyEvidence, readScannedAllergenSources, scannedAllergenTags }
  from "@/lib/server/barcode-policy";
import { attributionFor, loadUserProfile, policyCategoriesOf, type CatalogSource }
  from "@/lib/server/catalog";
import { ASSISTANT_NAME } from "@/lib/brand";
import { BY_APP, byModel, parseProvenance } from "@/lib/provenance";

export type AttachmentTurnRequest = CoachTurnRequest & { attachment: CoachAttachment };

type AttachmentProposeRequest = {
  method: "photo" | "label";
  mediaPath: string;
  localDate: string;
  tz: string;
  slot?: Extract<CoachAttachment, { kind: "capture" }>["slot"];
};

type AttachmentPropose = (
  client: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  req: AttachmentProposeRequest,
) => ReturnType<typeof proposeDraft>;

export type AttachmentTurnDeps = {
  now: () => number;
  newId: () => string;
  propose?: AttachmentPropose;
  /**
   * Epoch ms after which the turn is no longer saved: the route has already answered the phone a
   * retryable 503, so a late proposal must not land a turn the phone never saw (Sol review,
   * 2026-09-23). The retry, with the same messageId, runs the turn again.
   */
  saveBy?: number;
  /** W035: reserves this turn's budget slot, after the replay and capacity checks. */
  reserve?: () => Promise<void>;
};

type StoredMessage = Pick<MessageRow, "id" | "role" | "content" | "seq" | "tool_calls">
  & Partial<Pick<MessageRow, "model_id" | "ai_call_id" | "deflected">> & {
  thread_id: string;
  created_at?: string | null;
};

type RevisionRow = {
  id: number;
  catalog_food_id: number;
  description: string;
  brand: string | null;
  category: string | null;
  policy_categories: string[] | null;
  quality_class: BarcodeMatch["qualityClass"];
  quality_flags: string[];
  catalog_versions: { version_label: string };
  catalog_food_nutrients: { nutrient_code: string; amount_per_100g: number | null }[];
  catalog_portions: {
    id: number; description: string; gram_weight: number; is_default: boolean; seq: number;
  }[];
  catalog_ingredients: {
    seq: number; name: string; allergen_tags: string[] | null; raw_text: string | null;
  }[];
};

const REVISION_SELECT = `
  id, catalog_food_id, description, brand, category, policy_categories, quality_class, quality_flags,
  catalog_versions!inner ( version_label ),
  catalog_food_nutrients ( nutrient_code, amount_per_100g ),
  catalog_portions ( id, description, gram_weight, is_default, seq ),
  catalog_ingredients ( seq, name, allergen_tags, raw_text )`;

function mismatch(): never {
  throw new HttpError(400, "attachment_mismatch",
    "That scan no longer matches this food. Scan it again.");
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function proposeAttachment(
  client: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  req: AttachmentProposeRequest,
) {
  return proposeDraft(client, admin, userId, req);
}

async function replay(
  client: SupabaseClient,
  userId: string,
  messageId: string,
  requestedThreadId: string | null,
  now: () => number,
): Promise<CoachTurnResponse | null> {
  const startedAt = now();
  const first = await client.from("coach_messages")
    .select("id, thread_id, role, content, seq, tool_calls, created_at")
    .eq("user_id", userId).eq("id", messageId).maybeSingle();
  if (first.error) throw new HttpError(500, "internal", "Could not read the saved turn.");
  const user = first.data as StoredMessage | null;
  if (!user) return null;
  if (user.role !== "user") throw new HttpError(404, "not_found", "No such turn.");
  if (requestedThreadId !== null && requestedThreadId !== user.thread_id) {
    throw new HttpError(404, "not_found", "No such thread.");
  }
  const { data: thread, error: threadError } = await client.from("coach_threads")
    .select("id, kind").eq("id", user.thread_id).eq("user_id", userId)
    .is("deleted_at", null).maybeSingle();
  if (threadError) throw new HttpError(503, "history_unavailable", "Could not read the saved turn.");
  if (!thread || (thread as { kind: string }).kind !== "chat") {
    throw new HttpError(404, "not_found", "No such thread.");
  }
  const rest = await client.from("coach_messages")
    .select("id, thread_id, role, content, seq, tool_calls, created_at, model_id, ai_call_id, deflected")
    .eq("thread_id", user.thread_id).gte("seq", user.seq).lte("seq", user.seq + 1)
    .order("seq", { ascending: true });
  if (rest.error) throw new HttpError(500, "internal", "Could not read the saved turn.");
  const messages = ((rest.data ?? []) as StoredMessage[]).map(toMessageView);
  const assistant = messages.find((message) => message.role === "assistant");
  if (!assistant) {
    // The reply of a save the route gave up on may still be landing: a recent half turn is "try
    // again", and the retry replays the saved turn once it has (Sol r3, 2026-09-23). Long
    // abandoned, it is answered final and unsaved, as the text path does.
    const age = user.created_at ? Date.now() - Date.parse(user.created_at) : Infinity;
    if (age < INCOMPLETE_TURN_WINDOW_MS) {
      throw new HttpError(503, "in_progress", "Still working on that one. Try again in a moment.");
    }
    messages.push({ id: `${user.id}-incomplete`, role: "assistant",
      content: INCOMPLETE_TURN_REPLY, seq: user.seq + 1, provenance: BY_APP,
    } as (typeof messages)[number]);
  }
  const provenance = assistant ? assistant.provenance : BY_APP;
  return {
    threadId: user.thread_id,
    suggestions: [],
    actions: assistant?.actions ?? [],
    messages,
    draft: null,
    ...(assistant?.composed ? { composed: assistant.composed } : {}),
    deflected: false,
    toolsUsed: [],
    model: { provider: "gemini", modelId: "" },
    timings: { model: 0, ground: 0, attach: 0, "reply-done": elapsed(startedAt, now) },
    ...(provenance ? { provenance } : {}),
  };
}

/** Exported for its own concurrency proof (review round 1, finding #1) — every other caller
 *  reaches it through runAttachmentTurn. */
export async function barcodeDraft(
  client: SupabaseClient,
  userId: string,
  attachment: Extract<CoachAttachment, { kind: "barcode" }>,
) {
  const revisionId = Number(attachment.revisionId);
  if (!Number.isSafeInteger(revisionId) || revisionId <= 0) mismatch();
  const revisionRead = await client.from("catalog_food_revisions")
    .select(REVISION_SELECT).eq("id", revisionId).maybeSingle();
  if (revisionRead.error) {
    throw new HttpError(500, "catalog_failed", "That product could not be checked right now.");
  }
  const revision = revisionRead.data as unknown as RevisionRow | null;
  if (!revision) mismatch();

  const ingredients = [...(revision.catalog_ingredients ?? [])].sort((a, b) => a.seq - b.seq);
  // Display text: seq 1's own raw_text alone, same convention as search/detail/barcode.ts.
  const ingredientsText = ingredients.find((item) => item.seq === 1)?.raw_text ?? null;
  // sol BLOCK (finding #2, review round 1): the text scannedAllergenFacts reads for completeness
  // comes from completenessText instead, with its own `verbatim` flag — seq 1's raw_text alone is
  // only trusted as the complete label when no later row carries its own split raw_text too (the
  // same shape lib/server/barcode.ts's toMatch already guards against, via the same helper). A
  // later row's own raw_text proves seq 1's fragment is not the whole printed statement.
  const list = completenessText(ingredients.filter((item) => item.seq >= 1));
  // finding #10: this path used to build policy from policyEvidence alone, without the allergen
  // evidence/check machinery scannedAllergenFacts supplies — so the same scan could read a
  // different verdict here than on the barcode card, which already calls it (lib/server/barcode.ts
  // toMatch).
  //
  // sol FIX (review round 1, finding #1): `profile` used to be awaited here on its own before this
  // Promise.all — scannedAllergenFacts needs it, but its own two DB reads (readAllergenChecks,
  // readAllergenEvidence) do not, only the cheap in-memory merge does. Awaiting profile first
  // turned two sequential DB waves into three on this coach barcode-attachment hot path, raising
  // its p95 for no reason. `readScannedAllergenSources` runs those two reads in this SAME
  // Promise.all instead, alongside profile itself; only the synchronous merge
  // (`mergeScannedAllergenFacts`) waits on profile now.
  const [barcodeRead, refRead, prefRead, profile, sources] = await Promise.all([
    client.from("catalog_barcodes").select("catalog_food_id, source")
      .eq("gtin14", attachment.gtin14).eq("catalog_food_id", revision.catalog_food_id)
      .limit(1).maybeSingle(),
    client.from("food_refs").select("id, catalog_food_id")
      .eq("id", attachment.foodRefId).maybeSingle(),
    client.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", attachment.foodRefId).maybeSingle(),
    loadUserProfile(client),
    readScannedAllergenSources(client, userId, revision.id),
  ]);
  // finding (fixer pass): this path used to build allergenTags from the revision's structured
  // allergen_tags alone — a later row parsed to a NAME with no tag of its own (e.g. a split-off
  // "peanut" row) was invisible here even though search, detail (lib/server/catalog.ts) and the
  // barcode card (lib/server/barcode.ts toMatch) already scan parsed names for exactly this
  // signal via this same scannedAllergenTags helper (bug repro round 13, item 2).
  const allergenTags = scannedAllergenTags(ingredients, profile.avoid_allergens);
  const facts = mergeScannedAllergenFacts(
    profile, revision.id, list.text, allergenTags, sources, list.verbatim);
  const barcode = barcodeRead.data as { catalog_food_id: number; source: CatalogSource } | null;
  const ref = refRead.data as { id: string; catalog_food_id: number | null } | null;
  if (prefRead.error) {
    throw new HttpError(500, "policy_failed", "Your food rules could not be read.");
  }
  if (barcodeRead.error || refRead.error) {
    throw new HttpError(500, "catalog_failed", "That product could not be checked right now.");
  }
  if (!barcode || !ref
      || barcode.catalog_food_id !== revision.catalog_food_id
      || ref.catalog_food_id !== revision.catalog_food_id) mismatch();

  const status = (prefRead.data as { status?: string } | null)?.status;
  const prefStatus = status === "eats" || status === "avoid" ? status : null;
  const policy = evaluatePolicy(profile, { ...policyEvidence({
    foodRefId: attachment.foodRefId,
    prefStatus,
    description: revision.description,
    category: revision.category,
    policyCategories: policyCategoriesOf(revision.policy_categories, revision),
    qualityFlags: revision.quality_flags ?? [],
    ingredientCount: ingredients.length,
    allergenTags,
  // finding #2 (2026-10-02 DeepSeek audit): foodBrand/packaged, same as barcode.ts toMatch —
  // this is a scanned barcode attachment, never a generic unbranded whole food.
  }), ...facts, foodName: revision.description, foodBrand: revision.brand, packaged: true });
  const per100g: Record<string, number | null> = {};
  for (const nutrient of revision.catalog_food_nutrients ?? []) {
    per100g[nutrient.nutrient_code] = nutrient.amount_per_100g;
  }
  const match: BarcodeMatch = {
    foodRefId: attachment.foodRefId,
    catalogFoodId: revision.catalog_food_id,
    revisionId: revision.id,
    description: revision.description,
    brand: revision.brand,
    source: barcode.source,
    qualityClass: revision.quality_class,
    qualityFlags: revision.quality_flags ?? [],
    per100g,
    portions: [...(revision.catalog_portions ?? [])].sort((a, b) => a.seq - b.seq).map((item) => ({
      id: item.id,
      description: item.description,
      gramWeight: Number(item.gram_weight),
      isDefault: item.is_default,
    })),
    ingredientsText,
    allergenTags,
    attribution: attributionFor(barcode.source, revision.catalog_versions.version_label),
    policy,
  };
  return captureDraftSchema.parse({
    status: "resolved", gtin14: attachment.gtin14, cached: false, match,
  });
}

function blockPolicy(draft: ReturnType<typeof captureDraftSchema.parse>) {
  if ("status" in draft) {
    const blocked = draft.match.policy.verdict === "blocked";
    return { blocked, ...(draft.match.policy.reason ? { reason: draft.match.policy.reason } : {}),
      ...(blocked ? { blockedItemIds: [draft.match.foodRefId] } : {}) };
  }
  const blocked = draft.items.filter((item) => item.policy.verdict === "blocked");
  const reason = blocked.find((item) => item.policy.reason)?.policy.reason;
  const blockedItemIds = blocked.flatMap((item) => item.foodRefId ? [item.foodRefId] : []);
  return { blocked: blocked.length > 0, ...(reason ? { reason } : {}),
    ...(blockedItemIds.length > 0 ? { blockedItemIds } : {}) };
}

async function persistReply(
  client: SupabaseClient,
  userId: string,
  req: AttachmentTurnRequest,
  deps: AttachmentTurnDeps,
  content: string,
  attachMs: number,
  block?: LogDraftBlockV1,
): Promise<CoachTurnResponse> {
  const threadId = await resolveThread(client, userId, req.threadId, deps.newId);
  const seq = await nextSeq(client, threadId);
  const createdAt = new Date(deps.now()).toISOString();
  const base = { thread_id: threadId, user_id: userId, created_at: createdAt };
  const canonical = req.text.trim().length > 0 ? req.text : req.attachment.kind === "barcode"
    ? "Scanned a barcode"
    : req.attachment.method === "label" ? "Sent a label photo" : "Sent a photo";
  const userRow = {
    ...base, id: req.messageId, role: "user" as const, content: canonical, seq,
    tool_calls: { attachments: [req.attachment] }, policy_checks: [], deflected: false,
    model_id: null, ai_call_id: null,
  } satisfies MessageRow & { created_at: string };
  const attachedBlock = block
    ? { ...block, draft: attachDeterministicSanity(block.draft, {
      deterministic: deterministicSanity,
      typical: typicalServingSuggestion,
    }) } : undefined;
  // A capture draft is the capture model's read; a barcode draft and every reply without a draft
  // (the "couldn't read that photo" line) are the app's.
  const provenance = !block || block.source === "barcode" ? BY_APP
    : parseProvenance((block.draft as { provenance?: unknown }).provenance) ?? byModel();
  let assistantRow: MessageRow & { created_at: string } = {
    ...base, id: deps.newId(), role: "assistant" as const, content, seq: seq + 1,
    tool_calls: attachedBlock ? { blocks: [attachedBlock], provenance } : { provenance },
    policy_checks: [], deflected: false,
    model_id: null, ai_call_id: null,
  };
  const replyStartedAt = deps.now();
  if (deps.saveBy !== undefined && Date.now() >= deps.saveBy) {
    throw new HttpError(503, "timeout", `${ASSISTANT_NAME} did not answer in time. Try again.`);
  }
  const [savedUser, savedAssistant] = await persist(client, threadId, [userRow, assistantRow],
    req.threadId === null ? canonical : null);
  assistantRow = { ...assistantRow, seq: savedAssistant.seq };
  const replyDoneMs = elapsed(replyStartedAt, deps.now);
  if (block) {
    const sanityDeps = await import("@/lib/log/sanity").then((sanity) => ({
      check: sanity.checkSanity,
      schedule: (task: () => Promise<void>) => after(task),
    })).catch((error: unknown) => {
      console.error("coach attachment sanity import failed", {
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      });
      return null;
    });
    if (sanityDeps) {
      const remainingMs = Math.max(1, AFTER_RESPONSE_BUDGET_MS - attachMs - replyDoneMs);
      const sanity = startPersistedCoachSanity(
        client, userId, assistantRow.id, assistantRow.tool_calls, AbortSignal.timeout(remainingMs),
        sanityDeps,
      );
      assistantRow = { ...assistantRow, tool_calls: sanity.toolCalls };
      void sanity.settled;
    }
  }
  const messages: CoachMessageView[] = [{ ...userRow, seq: savedUser.seq }, assistantRow]
    .map(toMessageView);
  return {
    threadId, suggestions: [], actions: [], messages, draft: null, deflected: false,
    toolsUsed: [], model: { provider: "gemini", modelId: "" }, provenance,
    timings: { model: 0, ground: 0, attach: attachMs, "reply-done": replyDoneMs },
  };
}

export async function runAttachmentTurn(
  client: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  req: AttachmentTurnRequest,
  deps: AttachmentTurnDeps,
): Promise<CoachTurnResponse> {
  const stored = await replay(client, userId, req.messageId, req.threadId, deps.now);
  if (stored) return stored;
  // A saved turn still replays at capacity; a fresh ninth attachment refuses before photo or
  // barcode resolution. The insert trigger remains the concurrency authority.
  if (req.threadId === null) await assertChatCapacity(client, userId);
  await deps.reserve?.();

  if (req.attachment.kind === "barcode") {
    const attachStartedAt = deps.now();
    const draft = await barcodeDraft(client, userId, req.attachment);
    const attachMs = elapsed(attachStartedAt, deps.now);
    const block: LogDraftBlockV1 = {
      kind: "log_draft", v: 1, id: deps.newId(), source: "barcode",
      localDate: req.attachment.localDate,
      ...(req.attachment.slot ? { slot: req.attachment.slot } : {}),
      draft, policy: blockPolicy(draft), status: "pending",
    };
    return persistReply(client, userId, req, deps,
      "Here's what I found — check the portion and log it.", attachMs, block);
  }

  if (!req.attachment.mediaPath.startsWith(`media/${userId}/`)) {
    throw new HttpError(400, "attachment_mismatch",
      "That photo is not available for this account.");
  }
  const clock = accountClock(req, deps.now());
  const attachStartedAt = deps.now();
  try {
    const proposed = await (deps.propose ?? proposeAttachment)(client, admin, userId, {
      method: req.attachment.method,
      mediaPath: req.attachment.mediaPath,
      localDate: req.attachment.localDate,
      tz: clock.tz,
      ...(req.attachment.slot ? { slot: req.attachment.slot } : {}),
    });
    const attachMs = elapsed(attachStartedAt, deps.now);
    const draft = captureDraftSchema.parse(proposed);
    const block: LogDraftBlockV1 = {
      kind: "log_draft", v: 1, id: deps.newId(), source: "capture",
      method: req.attachment.method, localDate: req.attachment.localDate,
      ...(req.attachment.slot ? { slot: req.attachment.slot } : {}),
      draft, policy: blockPolicy(draft), status: "pending",
    };
    return persistReply(client, userId, req, deps,
      "Here's what I found — check it and log it.", attachMs, block);
  } catch (error) {
    if (error instanceof HttpError
        && error.code !== "provider_unavailable" && error.code !== "schema_invalid") throw error;
    console.error("coach capture attachment failed", {
      error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 300) }
        : { name: "UnknownError", message: "non-Error rejection" },
    });
    return persistReply(client, userId, req, deps,
      "I couldn't read that photo. Try again or search.", elapsed(attachStartedAt, deps.now));
  }
}
