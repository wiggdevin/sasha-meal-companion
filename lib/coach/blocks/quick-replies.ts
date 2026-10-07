import type { QuickRepliesBlockV1 } from "@/lib/coach/ui-blocks";

const URL = /(?:https?:\/\/|www\.)/i;

function sanitiseOption(value: string): string | null {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed || URL.test(collapsed)) return null;
  return Array.from(collapsed).slice(0, 40).join("").trim();
}

export function hydrateQuickReplies(
  id: string,
  rawOptions: readonly string[],
): QuickRepliesBlockV1 | null {
  const seen = new Set<string>();
  const options = rawOptions.flatMap((raw) => {
    const option = sanitiseOption(raw);
    if (!option) return [];
    const key = option.toLocaleLowerCase("en-US");
    if (seen.has(key)) return [];
    seen.add(key);
    return [option];
  }).slice(0, 4);
  return options.length >= 2
    ? { kind: "quick_replies", v: 1, id, options }
    : null;
}
