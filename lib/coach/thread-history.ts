import type { CachedMessage } from "@/lib/coach-client";

export const HISTORY_PAGE_SIZE = 50;

export type PrependAnchor = { scrollHeight: number; scrollTop: number };

export function capturePrependAnchor(element: HTMLElement): PrependAnchor {
  return { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
}

export function restorePrependAnchor(element: HTMLElement, anchor: PrependAnchor): void {
  element.scrollTop = anchor.scrollTop + element.scrollHeight - anchor.scrollHeight;
}

export function prependMessages<T extends Pick<CachedMessage, "id" | "seq">>(
  current: readonly T[], older: readonly T[],
): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of older) if (!byId.has(message.id)) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

export function oldestMessageSeq(messages: readonly Pick<CachedMessage, "seq">[]): number | null {
  return messages[0]?.seq ?? null;
}

export function pageMayHaveOlder(messages: readonly unknown[], limit = HISTORY_PAGE_SIZE): boolean {
  return messages.length === limit;
}
