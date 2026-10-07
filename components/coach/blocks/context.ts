import type { BarcodeDraftEdits } from "@/components/coach/editors/BarcodeDraftEditor";
import type { CaptureDraftEdits } from "@/components/coach/editors/CaptureDraftEditor";
import type { CoachAction } from "@/lib/coach/actions";
import type { Provenance } from "@/lib/types";
import type { FoodSearchBlockV1, LogDraftBlockV1 } from "@/lib/coach/ui-blocks";

export type FoodBlockRef = Pick<FoodSearchBlockV1["results"][number],
  "foodRefId" | "revisionId" | "name" | "blocked">;

export type LogDraftCommit = { entryIds: string[]; summary: string; saved?: string }; // saved: said once in place of "Logged"
export type LogDraftBlockContext = {
  tz: string;
  onBlockStatus: (blockId: string, status: LogDraftBlockV1["status"], entryIds?: string[]) => void | Promise<void>;
  onSearchManually: (block: LogDraftBlockV1) => void;
  rerunAsLabel: (block: LogDraftBlockV1) => void;
  rerunAsLabelUsed?: boolean;
  photoUrl?: (block: LogDraftBlockV1) => string | null | undefined;
  commitBarcode?: (block: LogDraftBlockV1, edits: BarcodeDraftEdits) => Promise<LogDraftCommit>;
  commitCapture?: (block: LogDraftBlockV1, edits: CaptureDraftEdits) => Promise<LogDraftCommit>;
  deleteEntry?: (localDate: string, entryId: string) => Promise<void>;
};

export type CoachBlockContext = LogDraftBlockContext & {
  sendText: (text: string) => void;
  logFood: (ref: FoodBlockRef) => void | Promise<string | undefined | void>; // a line to show once, if any
  markEats: (ref: FoodBlockRef) => void | Promise<void>;
  markAvoid: (ref: FoodBlockRef) => void | Promise<void>;
  /**
   * Queue a tapped coach action on the chat's action ledger (chat-state `compose_action`). The
   * shell applies it and renders its CoachActionCard with pending/applied/failed, Undo and Retry;
   * a block never calls applyCoachAction itself.
   */
  applyAction: (action: CoachAction) => void;
  isLatestAssistant: boolean;
  /** The message's own provenance (PR #373): a compose_meal card without one of its own inherits it. */
  provenance?: Provenance;
};
