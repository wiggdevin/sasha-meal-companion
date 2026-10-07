/** Only explicit history lookup uses these pure, bounded search/display helpers. */
export type HistorySource = {
  id: string; threadId: string; seq: number; role: "user" | "assistant";
  content: string; createdAt: string;
};

const STOP = new Set(("a about again all am an and another are as ask at be been between "
  + "chat conversation conversations could did discuss do earlier for from had has have hi history "
  + "how i in into is it last me my of on or other our previous said say show talk tell that the their "
  + "there these this those time to us was we were what when where which who why with you your").split(" "));

/** Only a past-tense question about this chat can rescue an otherwise aborted normal reply. */
export function isPastThreadQuestion(text: string): boolean {
  const question = text.trim();
  // Do not turn a compound instruction into read-only recall merely because it starts with
  // a question. A single past-only question may be rescued; an edit keeps its normal path.
  if (!/^[^.!?]{1,200}\?$/.test(question)
    || /\b(?:log|change|update|set|add|remove|move|delete|save|mark|swap|edit|clear|reschedule)\b/i.test(question)) return false;
  return /^(?:what\s+(?:was|were)\s+(?:my|our)\s+.{1,80}\b(?:idea|thought|suggestion)s?\b|what\s+did\s+(?:i|we)\s+(?:say|mention|discuss|decide|plan)\b|(?:can\s+you\s+)?remind\s+me\s+what\s+(?:i|we)\s+(?:said|discussed|decided|planned)\b)/i.test(question);
}

/** `websearch_to_tsquery` understands the OR tokens; punctuation/user operators do not reach it. */
export function historySearchTerms(question: string): string | null {
  const words = question.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const terms = [...new Set(words.filter((word) => word.length <= 40 && !STOP.has(word)))].slice(0, 8);
  return terms.length ? terms.join(" OR ") : null;
}

export function historyExcerpt(content: string, terms: readonly string[] = []): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= 300) return clean;
  const lower = clean.toLocaleLowerCase("en-US");
  const hits = terms.map((term) => lower.indexOf(term.toLocaleLowerCase("en-US")))
    .filter((index) => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(first - 70, clean.length - 300));
  const fragment = clean.slice(start, start + 300).trim();
  return `${start > 0 ? "…" : ""}${fragment}${start + 300 < clean.length ? "…" : ""}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved message" : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(date);
}

/** Quotes rather than a generated synthesis; every line has a saved-message citation. */
export function historyAnswer(title: string, sources: readonly HistorySource[], question = ""): string {
  if (!sources.length) return `I could not find matching saved messages in “${title}”. Try a more specific topic or choose another chat.`;
  const terms = historySearchTerms(question)?.split(" OR ") ?? [];
  const lines = sources.map((source, index) =>
    `[${index + 1}] ${dateLabel(source.createdAt)} · ${source.role === "user" ? "You" : "Coach"}: “${historyExcerpt(source.content, terms)}”`);
  return `I found these saved excerpts in “${title}” (not a full summary):\n\n${lines.join("\n\n")}`;
}
