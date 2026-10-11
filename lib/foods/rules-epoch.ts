/**
 * F3 (2026-10-05 calculation audit): a verified eligible set, or an accepted recipe's rule mark, is
 * never reused across a food-rules change. The epoch is the phone's rules watermark for the inputs
 * it does not hold (allergens, banned categories, conditions, custom and profile rules):
 *
 * - every direct rule write calls `noteFoodRulesChanged()` on success AND on a conflict (a conflict
 *   means another writer moved the rules);
 * - every constraint revision the phone reads goes through `noteRulesRevision(rev)`, so a change
 *   made on another device moves the epoch the first time this phone sees its revision.
 *
 * A moved epoch revokes every set and recipe mark stamped under an older one (checked lazily, so no
 * set escapes by being evicted from a list), and fires the two re-read signals Today already
 * listens to: `SYNCED_EVENT` (the eligible set, as `components/settings/AppProfileCard.tsx` does
 * after its own direct write) and `recipe-plan-accepted` (the accepted-selection marks).
 *
 * Rule changes that travel through the outbox need no call: an Avoid/Eats mark changes the Food
 * row, which the eligible view reads at once, and diet flags are compared by key.
 * The epoch is per tab; another tab catches up through its own next constraint read or sync.
 * Revisions and signatures are remembered per account, and a newly seen account moves the epoch.
 */
// lib/sync/client.ts's SYNCED_EVENT, spelled here so lib/store.ts can import this module without a
// cycle (tests/today/current-rule-marks.test.ts pins the two strings equal).
export const SYNCED_EVENT = "meal-companion:synced";

/** Today's accepted-selection reader re-reads on this event (app/page.tsx). */
export const RECIPE_SELECTIONS_EVENT = "recipe-plan-accepted";

// Starts from the load time, not 0: a mark stamped in an earlier page load never matches this one.
let epoch = Date.now();
/** Per account: the last constraint revision and rule-set signatures this tab has seen. */
const knownRevisions = new Map<string, number>();
const knownSignatures = new Map<string, string>();
let lastAccount: string | null = null;

/** The epoch a request starts under; anything stamped with an older one is stale. */
export function foodRulesEpoch(): number {
  return epoch;
}

const listeners = new Set<() => void>();

/** Called on every epoch move (the meal snapshot store forgets its copy, lib/foods/meal-snapshot-store.ts). */
export function onFoodRulesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bump(): void {
  epoch += 1;
  for (const listener of listeners) {
    try { listener(); } catch { /* a listener never blocks the re-read signals */ }
  }
  globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
  globalThis.dispatchEvent?.(new Event(RECIPE_SELECTIONS_EVENT));
}

/** Another account's rules are other rules: the first sighting of a new account moves the epoch. */
function noteAccount(account: string | undefined): void {
  if (account === undefined) return;
  if (lastAccount !== null && lastAccount !== account) bump();
  lastAccount = account;
}

export function noteFoodRulesChanged(revision?: number, account?: string): void {
  noteAccount(account);
  bump();
  if (revision === undefined || !Number.isFinite(revision)) return;
  const key = account ?? "";
  knownRevisions.set(key, Math.max(revision, knownRevisions.get(key) ?? revision));
}

/**
 * A constraint revision the server reported. A newer one than last seen is a rules change. An
 * older one is a late answer computed before a newer revision: the known revision is not rewound,
 * and the epoch still moves so anything stamped alongside that answer is revoked (fail closed).
 */
export function noteRulesRevision(revision: number, account?: string): void {
  if (!Number.isFinite(revision)) return;
  noteAccount(account);
  const key = account ?? "";
  const known = knownRevisions.get(key);
  if (known === undefined || revision > known) knownRevisions.set(key, revision);
  if (known !== undefined && revision !== known) bump();
}

/**
 * A rule input the server keeps without a constraint revision (profile instances), as a stable
 * signature. A signature other than the last one seen for that account and source is a rules
 * change, so a confirm made on another device revokes this phone's sets too.
 */
export function noteRulesSignature(source: string, signature: string, account?: string): void {
  noteAccount(account);
  const key = `${account ?? ""}\u0000${source}`;
  const known = knownSignatures.get(key);
  knownSignatures.set(key, signature);
  // The first sighting moves the epoch too: a set this tab already holds was verified without
  // knowing it, so it may predate a change made on another device (review round 3, WARN 4).
  if (known !== signature) bump();
}

/**
 * The account's diet flags as the phone stores them (review round 3, BLOCK). Called by
 * lib/store.ts whenever a save changes them, whoever wrote them: a diet edit, onboarding, a coach
 * profile change, or a sync pull from another device. The move is deferred a microtask so the
 * re-read signals never fire inside the store write that caused them.
 */
export function noteDietFlagsChanged(account: string | null): void {
  queueMicrotask(() => noteFoodRulesChanged(undefined, account ?? undefined));
}

/*
 * Avoid/Eats marks do not move the epoch above (the eligible view reads the Food row at once), but a
 * verdict that was computed and stored, such as an offline barcode match (lib/barcode/client.ts,
 * W014 review round 1), must not outlive one. A second watermark moves whenever any food's status
 * changes in the store, whoever wrote it: a tap here, the coach, or a pull from another device.
 */
let membershipEpoch = Date.now();

/** The Avoid/Eats watermark: a verdict stored under an older one may miss a mark. */
export function foodMembershipEpoch(): number {
  return membershipEpoch;
}

type StatusRows = Readonly<Record<string, { status?: unknown } | undefined>>;

/** Called by lib/store.ts on every save: moves the watermark when any food's status changed. */
export function noteFoodStatuses(before: StatusRows, after: StatusRows): void {
  if (before === after) return;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of ids) {
    if (before[id]?.status !== after[id]?.status) {
      membershipEpoch += 1;
      return;
    }
  }
}

/** Tests only: forget every remembered revision, signature and account. */
export function resetFoodRulesMemoryForTests(): void {
  knownRevisions.clear();
  knownSignatures.clear();
  lastAccount = null;
}
