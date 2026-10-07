import { runTurn as liveRunTurn } from "@/lib/server/coach-turn";
import type { LogEntryExistsPort } from "@/lib/server/coach-unlogged-meal";

// Model-reply fixtures default to an already logged day. Tests for an unlogged day override
// logEntryExists explicitly; an empty fake database must not decide the next-action chip.
const loggedDay: LogEntryExistsPort = async () => true;

export const runTurn: typeof liveRunTurn = (client, admin, userId, req, deps = {}) =>
  liveRunTurn(client, admin, userId, req, { logEntryExists: loggedDay, ...deps });
