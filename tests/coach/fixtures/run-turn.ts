import { runTurn as liveRunTurn } from "@/lib/server/coach-turn";
import type { LogEntryExistsPort } from "@/lib/server/coach-unlogged-meal";
import { withCoachSaveTurn } from "@/tests/helpers/coach-save-turn";

// Model-reply fixtures default to an already logged day. Tests for an unlogged day override
// logEntryExists explicitly; an empty fake database must not decide the next-action chip.
const loggedDay: LogEntryExistsPort = async () => true;

// The turn is saved through `coach_save_turn` (W088); the fake admin plays it on its own tables.
export const runTurn: typeof liveRunTurn = (client, admin, userId, req, deps = {}) =>
  liveRunTurn(client, withCoachSaveTurn(admin), userId, req, { logEntryExists: loggedDay, ...deps });
