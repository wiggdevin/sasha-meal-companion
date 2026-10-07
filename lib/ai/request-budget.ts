import { AsyncLocalStorage } from "node:async_hooks";

const MAX_LOGICAL_CALLS = 3;
const EXEMPT_PURPOSES = new Set(["food_facets"]);

type JevBudget = {
  logicalCalls: Set<string>;
};

const requestBudget = new AsyncLocalStorage<JevBudget>();

/** Carries one Jev budget through every async hop in a server request. */
export function withJevBudget<T>(fn: () => T): T {
  return requestBudget.run({ logicalCalls: new Set() }, fn);
}

/**
 * Claims one logical call. Reusing its stable key is a retry and costs no extra slot.
 * Calls outside a request scope retain the wrapper's existing fail-open behaviour.
 */
export function claimJevCall(purpose: string, logicalCallKey: string): boolean {
  if (EXEMPT_PURPOSES.has(purpose)) return true;
  const budget = requestBudget.getStore();
  if (!budget || budget.logicalCalls.has(logicalCallKey)) return true;
  if (budget.logicalCalls.size >= MAX_LOGICAL_CALLS) return false;
  budget.logicalCalls.add(logicalCallKey);
  return true;
}
