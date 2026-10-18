"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useCapabilities } from "@/components/CapabilitiesProvider";
import { DockIntentReceiver, DockScanReceiver } from "@/components/coach/attachments/dock-handoff";
import CoachShell, { type CoachShellProps } from "@/components/coach/CoachShell";
import HistorySourceCards from "@/components/coach/HistorySourceCards";
import TasteChipsCard from "@/components/coach/TasteChipsCard";
import type { CoachShellControls } from "@/components/coach/attachments/useAttachmentTurn";
import { renderBlock } from "@/components/coach/blocks";
import type {
  CoachBlockContext, FoodBlockRef, LogDraftBlockContext,
} from "@/components/coach/blocks/context";
import { getFoodDetail, searchFoods, toCachedRevision } from "@/lib/catalog-client";
import type { CaptureAttachment, CoachAttachment } from "@/lib/coach/attachments";
import type { CoachMessageView } from "@/lib/coach/message-view";
import { readHistoryEvidence } from "@/lib/coach-client";
import { getRevision, type CachedRevision } from "@/lib/db/catalog-cache";
import { currentPrefStatus, isLatestFoodMembershipIntent, reserveFoodMembershipIntent,
  setFoodMembership } from "@/lib/foods/prefs-client";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { commitLogEntry } from "@/lib/log-commit-client";
import { buildCommitRequest } from "@/lib/log-client";
import { catalogCard } from "@/lib/log/catalog-card";
import { savedFrom } from "@/lib/log/outcome";
import { NUTRITION_UNCHECKED_COPY, commitNutritionUnchecked } from "@/lib/nutrition-display";
import { accountHandle, assertCurrent } from "@/lib/device/account";
import { getFoods, setFoodStatus } from "@/lib/store";
import Notice from "@/components/ui/Notice";

type Props = Omit<CoachShellProps, "toolbar" | "renderExtras"> & {
  onOpenConversation?: (threadId: string) => void;
};

async function revisionFor(ref: FoodBlockRef): Promise<CachedRevision> {
  const revisionId = Number(ref.revisionId);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
    throw new Error("That food is no longer available.");
  }
  const cached = await getRevision(revisionId);
  if (cached) return cached;
  const result = await searchFoods(ref.name, { limit: 8 });
  const hit = result.kind === "online"
    ? result.hits.find((candidate) => candidate.revisionId === revisionId) : undefined;
  if (!hit) throw new Error("Open Foods to refresh that serving, then try again.");
  const detail = await getFoodDetail(hit.catalogFoodId, { revisionId });
  if (detail.kind === "ok") return toCachedRevision(detail.detail);
  if (detail.kind === "cached") return detail.revision;
  throw new Error("That serving could not be loaded. Try again.");
}

/** Logs one serving; answers the one line the block shows beside its row when the save needs a word
 *  more ("Saved. Nutrition not fully checked."), otherwise nothing. */
async function logFood(ref: FoodBlockRef, tz: string): Promise<string | undefined> {
  const revision = await revisionFor(ref);
  const portions = revision.portions
    .filter((candidate) => Number.isFinite(candidate.gramWeight) && candidate.gramWeight > 0);
  const portion = portions.find((candidate) => candidate.isDefault) ?? portions[0] ?? null;
  const grams = portion?.gramWeight ?? 100;
  const at = new Date();
  const entryId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const entry = catalogCard({
    revision, entryId, itemId, foodRefId: ref.foodRefId, grams, qty: 1, portion, at,
    flags: ref.blocked ? ["off-plan"] : undefined,
  });
  const request = buildCommitRequest({
    entryId, eatenAt: at, tz, slot: "snack",
    items: [{ id: itemId, foodRefId: ref.foodRefId, revision, grams, qty: 1,
      unit: portion ? "portion" : "g", portionId: portion?.id ?? null }],
  });
  const result = await commitLogEntry(request, {
    optimistic: { date: request.local_date, entry }, timingPath: "search-log",
  });
  const saved = savedFrom(result);
  if (!saved.ok) throw new Error(saved.message);
  return commitNutritionUnchecked(result) ? NUTRITION_UNCHECKED_COPY : undefined;
}

export async function markFood(ref: FoodBlockRef, status: "eats" | "avoid"): Promise<void> {
  const normalized = normalizeFoodName(ref.name);
  const local = Object.values(getFoods())
    .find((food) => normalizeFoodName(food.name) === normalized);
  // The account that tapped owns every step; a switch mid-mark writes nothing for the new one.
  const h = accountHandle();
  const intent = reserveFoodMembershipIntent(ref.name, h);
  const previous = await currentPrefStatus(ref.foodRefId, h);
  assertCurrent(h);
  if (!isLatestFoodMembershipIntent(intent)) return;
  const note = previous?.note ?? local?.note ?? null;
  await setFoodMembership(ref.name, status, { note: null, account: h, intent });
  assertCurrent(h);
  if (!isLatestFoodMembershipIntent(intent)) return;
  if (local) setFoodStatus(local.id, status, note ?? undefined);
}

function captureBefore(
  message: CoachMessageView, messages: readonly CoachMessageView[],
): CaptureAttachment | undefined {
  return messages.find((candidate) => candidate.role === "user" && candidate.seq === message.seq - 1)
    ?.attachments?.find((attachment): attachment is CaptureAttachment =>
      attachment.kind === "capture" && attachment.method === "photo");
}

function labelPostedAfter(message: CoachMessageView, messages: readonly CoachMessageView[], mediaPath: string) {
  return messages.some((candidate) => candidate.role === "user" && candidate.seq > message.seq
    && candidate.attachments?.some((attachment) => attachment.kind === "capture"
      && attachment.method === "label" && attachment.mediaPath === mediaPath));
}

export function CoachMessageExtras({
  message, messages, tz, onAttachment, onSearchManually, onBlockStatus,
  sendText, applyAction, commitBarcode, commitCapture, deleteEntry, onOpenConversation,
}: {
  message: CoachMessageView;
  messages: readonly CoachMessageView[];
  tz: string;
  onAttachment: (attachment: CoachAttachment, optimisticText: string) => void | Promise<boolean>;
  onSearchManually: () => void;
  sendText?: CoachBlockContext["sendText"];
  /** The shell's action ledger; without one (a bare render) a block's tap queues nothing. */
  applyAction?: CoachBlockContext["applyAction"];
  onBlockStatus: LogDraftBlockContext["onBlockStatus"];
  commitBarcode?: LogDraftBlockContext["commitBarcode"];
  commitCapture?: LogDraftBlockContext["commitCapture"];
  deleteEntry?: LogDraftBlockContext["deleteEntry"];
  onOpenConversation?: (threadId: string) => void;
}) {
  const [rerunBlockIds, setRerunBlockIds] = useState(() => new Set<string>());
  const [rerunErrors, setRerunErrors] = useState<Record<string, string>>({});
  if (!message.blocks?.length && !message.historySources?.length && !message.tasteChips) return null;
  return <div className="flex flex-col gap-3">
    {message.historySources?.length ? <HistorySourceCards sources={message.historySources}
      readEvidence={readHistoryEvidence} onOpenConversation={onOpenConversation} /> : null}
    {message.tasteChips && <TasteChipsCard card={message.tasteChips} messageId={message.id} />}
    {message.blocks?.map((block) => {
      const attachment = captureBefore(message, messages);
      const rerunUsed = block.kind === "log_draft" && (block.method === "label"
        || rerunBlockIds.has(block.id)
        || (attachment ? labelPostedAfter(message, messages, attachment.mediaPath) : false));
      return <Fragment key={block.id}>
        {renderBlock(block, {
          tz, onBlockStatus, onSearchManually, commitBarcode, commitCapture, deleteEntry,
          sendText: sendText ?? (() => {}), logFood: (ref) => logFood(ref, tz),
          markEats: (ref) => markFood(ref, "eats"),
          markAvoid: (ref) => markFood(ref, "avoid"),
          applyAction: applyAction ?? (() => {}),
          provenance: message.provenance,
          isLatestAssistant: message.role === "assistant"
            && messages[messages.length - 1]?.id === message.id,
          rerunAsLabelUsed: rerunUsed,
          rerunAsLabel: () => {
            const photo = captureBefore(message, messages);
            if (!photo) {
              setRerunErrors((current) => ({ ...current,
                [block.id]: "Can’t rerun — take the photo again" }));
              return;
            }
            setRerunErrors((current) => {
              const { [block.id]: _removed, ...rest } = current;
              return rest;
            });
            setRerunBlockIds((current) => new Set(current).add(block.id));
            const posted = onAttachment({ ...photo, method: "label" }, "Sent a label photo");
            if (posted instanceof Promise) void posted.then((ok) => {
              if (!ok) setRerunBlockIds((current) => {
                const next = new Set(current); next.delete(block.id); return next;
              });
            });
          },
        })}
        {rerunErrors[block.id] && <Notice tone="error" title={rerunErrors[block.id]} />}
      </Fragment>;
    })}
  </div>;
}

/** Compatibility wrapper that wires chat-first controls into the shell's stable slots. */
export default function CoachChat(props: Props) {
  const capabilities = useCapabilities();
  const consumedScanQuery = useRef(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanUnavailable, setScanUnavailable] = useState(false);
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  useEffect(() => {
    if (consumedScanQuery.current) return;
    consumedScanQuery.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("open") !== "scan") return;
    if (capabilities.scan) queueMicrotask(() => setScanOpen(true));
    else queueMicrotask(() => setScanUnavailable(true));
    url.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [capabilities.scan]);

  const toolbar = (controls: CoachShellControls) => <>
    {/* The dock's attach tray hands a picked image to this thread (dock-handoff), read for a
        barcode first when scanning is on; `?open=scan` above is the /scan shortcut's sheet. */}
    {scanUnavailable && <Notice tone="attention" title="Scanning isn't available yet"
      onDismiss={() => setScanUnavailable(false)}>
      Search for the food by name instead.
    </Notice>}
    <DockIntentReceiver ready={!controls.disabled} onAttachment={controls.sendAttachment}
      scanEnabled={capabilities.scan && !controls.scanDisabled} />
    {capabilities.scan && <DockScanReceiver open={scanOpen} onClose={() => setScanOpen(false)}
      onAttachment={controls.sendAttachment}
      onSearchManually={(description) => controls.sendText(`Log ${description}`)} />}
  </>;

  return <CoachShell {...props} toolbar={toolbar}
    renderExtras={(message, controls, messages, applyAction, sendText) => <CoachMessageExtras
      message={message as CoachMessageView} messages={messages as CoachMessageView[]} tz={tz}
      onAttachment={controls.sendAttachment} onBlockStatus={controls.onBlockStatus}
      sendText={sendText} applyAction={applyAction}
      onOpenConversation={props.onOpenConversation}
      onSearchManually={() => controls.sendText("Help me find another food match")} />} />;
}

export {
  CoachComposedCards, CoachErrorNotice, nextPendingAction, threadRestoreFailure,
} from "@/components/coach/CoachShell";
export {
  COMPOSER_OFFLINE_COPY, initialChatState, localDate, nextChatState,
  type ChatAction, type ChatEvent, type ChatMessage, type ChatState,
} from "@/lib/coach/chat-state";
