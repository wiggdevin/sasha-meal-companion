/**
 * The offline Jev pair-label store (Phase 18 D9 item 2, W1c acceptance 2). Offline build only.
 *
 * Every stored raw probability is keyed by sha256 of the model id, PAIR_PROMPT_VERSION,
 * PAIR_RUBRIC_VERSION, the frozen question and the item as Jev reads it. A refresh asks Jev only
 * for items with no stored key and never rewrites an existing one, so a refresh under the same model
 * id, prompt and rubric changes no stored probability. A new model id or a version bump makes new
 * keys beside the old ones; nothing is overwritten.
 *
 * The store holds Jev's own raw answers only. Human labels live in the holdout CSV
 * (docs/pairing/holdout-pairs.csv), which nothing here writes: Jev never grades its own labels.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "@/lib/foods/sha256";
import {
  PAIR_PROMPT_VERSION, PAIR_QUESTION, PAIR_RUBRIC_VERSION, pairItemState, type PairItem,
} from "@/lib/foods/pairing/questions";
import { canonical } from "@/scripts/priors/artifact-io";

export const LABEL_STORE_PATH = "scripts/pairing/data/jev-pair-labels.json";

const LabelSchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/), id: z.string(), model: z.string().min(1),
  promptVersion: z.string(), rubricVersion: z.string(), p: z.number().min(0).max(1),
});
const StoreSchema = z.strictObject({ version: z.literal(1), purpose: z.literal("pair_plausibility"), labels: z.array(LabelSchema) });
export type JevLabel = z.infer<typeof LabelSchema>;
export type LabelStore = z.infer<typeof StoreSchema>;

export const emptyStore = (): LabelStore => ({ version: 1, purpose: "pair_plausibility", labels: [] });

export function labelKey(model: string, item: PairItem): string {
  return sha256Hex(canonical({ model, promptVersion: PAIR_PROMPT_VERSION, rubricVersion: PAIR_RUBRIC_VERSION,
    question: PAIR_QUESTION, item: pairItemState(item) }));
}

export function readStore(path = LABEL_STORE_PATH): LabelStore {
  if (!existsSync(path)) return emptyStore();
  const parsed = StoreSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`malformed Jev label store ${path}`);
  return parsed.data;
}

export function storeText(store: LabelStore): string {
  const labels = [...store.labels].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `{"labels":[\n${labels.map(canonical).join(",\n")}\n],"purpose":"pair_plausibility","version":1}\n`;
}

export function writeStore(store: LabelStore, path = LABEL_STORE_PATH): void {
  writeFileSync(path, storeText(store));
}

/** Items with no stored label under this model id and the current prompt and rubric. */
export function missingItems(store: LabelStore, items: readonly PairItem[], model: string): PairItem[] {
  const have = new Set(store.labels.map((label) => label.key));
  return items.filter((item) => !have.has(labelKey(model, item)));
}

/** Adds new answers; an answer whose key is already stored is ignored, never written over. */
export function mergeLabels(store: LabelStore, answers: readonly { item: PairItem; p: number }[], model: string): LabelStore {
  const have = new Set(store.labels.map((label) => label.key));
  const added: JevLabel[] = [];
  for (const { item, p } of answers) {
    const key = labelKey(model, item);
    if (have.has(key)) continue;
    have.add(key);
    added.push({ key, id: item.id, model, promptVersion: PAIR_PROMPT_VERSION, rubricVersion: PAIR_RUBRIC_VERSION, p });
  }
  return { ...store, labels: [...store.labels, ...added] };
}

/** Stored raw probabilities by item id, for this model id and the current prompt and rubric. */
export function labelsFor(store: LabelStore, items: readonly PairItem[], model: string): Map<string, number> {
  const byKey = new Map(store.labels.map((label) => [label.key, label.p]));
  const out = new Map<string, number>();
  for (const item of items) {
    const p = byKey.get(labelKey(model, item));
    if (p !== undefined) out.set(item.id, p);
  }
  return out;
}
