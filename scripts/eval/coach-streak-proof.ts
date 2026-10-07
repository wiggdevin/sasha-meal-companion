import type { Assertion } from "./coach-streak-state";

type StoredBlockActual = {
  blocks?: readonly unknown[];
  persistedBlocks?: readonly unknown[];
};

export function persistedBlockEvidence(actual: StoredBlockActual): {
  persistedBlocks: readonly unknown[];
  assertion: Assertion;
} {
  const hasPersistedBlocks = Array.isArray(actual.persistedBlocks);
  return {
    persistedBlocks: hasPersistedBlocks ? actual.persistedBlocks ?? [] : [],
    assertion: {
      name: "persisted block proof",
      passed: hasPersistedBlocks,
      detail: hasPersistedBlocks
        ? "actual.persistedBlocks is present"
        : "actual.persistedBlocks is missing; client-view blocks are not accepted",
    },
  };
}
