import Tag from "@/components/ui/Tag";
import type { Provenance } from "@/lib/types";

/** The Jev purpose that orders suggestion cards (lib/coach/suggest.ts); the only Jev use that is labelled. */
const RANKING = "suggest-options";

/**
 * The copy for a provenance, or null when no label shows. A model wrote it: "AI". Jev ranked the
 * cards: "AI ranked". Any other Jev use (the intent fast path: a templated reply, an action, a chart
 * drawn from logs) wrote no words, so it carries no label; nor do app-written content and legacy rows.
 */
export function aiLabelCopy(provenance: Provenance | null | undefined) {
  if (provenance?.ai !== true) return null;
  if (provenance.source === "model") return { text: "AI", name: "Written by AI" };
  return provenance.purpose === RANKING ? { text: "AI ranked", name: "Ranked by AI" } : null;
}

/**
 * The one quiet mark that AI produced an item (PR #373's provenance): "AI" for a model's words, "AI
 * ranked" for a Jev-ranked suggestion card, nothing for app-written content or a row that cannot tell. A
 * neutral Tag (12 px, graphite on a 6 % ink wash; its pairs are in tests/design/contrast-table.ts),
 * shown once per item and never per line. It has no motion of its own: it arrives with its item.
 * No spark glyph (owner, 2026-10-04): the words alone mark it.
 */
export default function AiLabel({ provenance, className }: {
  provenance: Provenance | null | undefined; className?: string;
}) {
  const copy = aiLabelCopy(provenance);
  if (!copy || !provenance) return null;
  return <Tag tone="neutral" data-ai-label={provenance.source} className={className}>
    <span aria-hidden="true">{copy.text}</span>
    <span className="sr-only">{copy.name}</span>
  </Tag>;
}
