/**
 * Plan-sheet tests written against the coach reply: chips (and the opening "Choose for me") now
 * go to POST /api/plan/ideas (lib/plan/ideas-client.ts), not a coach turn. This double serves a
 * chip from the same mocked coach reply, so a test about photos, documents, signals or notices
 * keeps one source of cards. The chip request is passed to `postTurn` as `{ chip: <body> }`.
 */
import type { Mock } from "vitest";

type TurnLike = { messages?: { role: string; content: string }[]; composed?: unknown[];
  provenance?: unknown };

export function ideasFromTurn(postTurn: Mock) {
  return async (_account: unknown, body: { chip: string }) => {
    const turn = await postTurn({ chip: body }) as TurnLike;
    const message = turn.messages?.findLast((row) => row.role === "assistant")?.content;
    return { cards: turn.composed ?? [], chip: body.chip, serverMs: 1,
      provenance: turn.provenance ?? { ai: false, source: "app" }, ...(message ? { message } : {}) };
  };
}
