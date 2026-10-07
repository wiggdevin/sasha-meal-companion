/**
 * Phase 13 §6 row 5, §9 R7: the live half of the reply check.
 *
 * lib/coach/reply-check.ts is pure — its text scan only ever looks at `evidence`, the foods this
 * turn already searched for. This module extracts every food the reply's own prose names (block
 * and suggestion ids first, then turn evidence, then lib/coach/reply-mentions.ts's lexicon and
 * best-effort sweep resolved through the catalog search every coach tool uses), and checks each
 * against the account's active hard rules: the legacy constraint lists, and confirmed dietary
 * profile hard rules against cached facets (lib/server/reply-check-profile.ts).
 *
 * R7's rule: a reply that recommends a food must carry a checked id. With an active hard rule,
 * a hard hit the prose names, a food the check cannot resolve to a checked id, a suggestion whose
 * id came only from the model, or a check that could not finish (a rejected search, its own
 * deadline) all replace the reply with a re-ask. A card's id is checked when turn evidence or one
 * of the turn's own blocks (the draft) resolved it, or when policy already blocks the card on it.
 * The re-ask replaces the reply, not the verdicts: a blocked card stays on screen as blocked
 * (Phase 7). Without an active hard rule nothing here can change a verdict, so no catalog search
 * runs at all.
 *
 * Timing: the caller starts `startReplyScan` alongside coach-verify, with its own deadline
 * (REPLY_CHECK_BUDGET_MS, the Jev verify window), and `checkReplyLive` only awaits it.
 */
import { shoppingItemNames, withoutShoppingConfirmations } from "@/lib/coach/shopping-confirmation";
import type { CoachAction } from "@/lib/coach/actions";
import { allergenFacts, checkItem, type EvidenceByName } from "@/lib/coach/policy";
import {
  cardEvidence, checkReply, loggedFoodIdentities, type LoggedIdentities,
  type ReplyCheckInput, type ReplyCheckResult,
} from "@/lib/coach/reply-check";
import {
  candidatePhrases, hitNamesPhrase, lexiconMentions, normalizeFoodText,
} from "@/lib/coach/reply-mentions";
import { abortMessage, type RawSuggestion } from "@/lib/coach/turn";
import type { FoodHit } from "@/lib/coach/executors";
import type { CoachSuggestion } from "@/lib/coach/types";
import { LANES } from "@/lib/ai/lanes";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { DietEvidence } from "@/lib/policy/diet-evidence";
import type { ProfileRuleSet } from "@/lib/policy/profiles/hard-rules";
import {
  profileMarksFor, resolveProfileEvidence, settleBy, type FacetFood, type ProfileEvidencePorts,
  type Settled,
} from "@/lib/server/reply-check-profile";

/** The reply check's own budget: the Jev verify window it runs beside (LANES.judge). */
export const REPLY_CHECK_BUDGET_MS = LANES.judge.budgetMs ?? 3_000;
/** Candidates per catalog search: the matching hit need not be the first one. */
const SEARCH_LIMIT = 3;

export type ReplyCheckPorts = ProfileEvidencePorts & {
  searchFoods: (userId: string, query: string, limit: number) => Promise<FoodHit[]>;
  /** The account's active confirmed profile hard rules (lib/policy/profiles/account-rules.ts). */
  profileRules?: (userId: string) => Promise<ProfileRuleSet | null>;
};

/** `text` is the model's own prose — never copy the turn built and already checked itself. */
const SLOT_WORDS = ["snack", "snacks", "breakfast", "brunch", "lunch", "dinner", "supper", "meal",
  "meals"];

export type ReplyScanInput = {
  userId: string; text: string; named: readonly RawSuggestion[]; evidence: EvidenceByName;
  profile: ConstraintProfile;
  /** §6 "block food ids first": the foods the turn's own blocks resolved through the catalog. */
  blockFoods?: readonly { name: string; foodRefId: string }[];
  /** finding #6: this turn's own actions, so a logged food is exempt from the prose scan below. */
  actions?: readonly CoachAction[];
  /**
   * The food names the model's own final step logs, read before grounding. 2026-10-02 DeepSeek
   * audit (finding #3): this raw, pre-grounding claim is no longer the primary exemption source —
   * see `groundedLogged` below — and survives only as the `rawLoggedIdentities` fallback for a
   * direct caller that never supplies a deferred (every test below, unchanged).
   */
  loggedNames?: readonly string[];
  /** The model's own final-step actions before grounding: the scan starts before `actions` holds
   *  them, and a shopping add's confirmation sentence is set aside from them (2026-10-02). */
  pendingActions?: readonly { kind: string; names?: unknown }[];
  /**
   * 2026-10-02 DeepSeek audit (finding #3): the turn's actually-GROUNDED log_meal identities,
   * resolved once lib/server/coach-turn/final-step.ts's groundAll() settles — not the raw,
   * pre-grounding `actions`/`loggedNames` above. An advised food the model claimed to log but that
   * never grounded (no catalog row; log-meal.ts turned it into a clarification instead) must not
   * ride the exemption with no real log behind it. `scan` awaits this exactly where it needs the
   * exemption, well after the profile-rules and catalog work already in flight below, so grounding
   * and the scan finish in parallel with no added latency. Absent (every direct caller) falls back
   * to `rawLoggedIdentities`; present but never settling in time exempts nothing (fail closed).
   */
  groundedLogged?: Promise<LoggedIdentities>;
};

export type ReplyFailure = { name: string; reason: string | null };
export type ReplyScan = { hardRulesActive: boolean; complete: boolean; failing: ReplyFailure[] };

type Entry = EvidenceByName[string];
/** `shopping`: an item this turn puts on the shopping list, judged only on a definite clash. */
type Mention = { name: string; entry: Entry; named: boolean; inProse: boolean; shopping?: boolean };

export function hasActiveHardRules(profile: ConstraintProfile): boolean {
  return profile.avoid_allergens.length > 0 || profile.avoid_food_ref_ids.length > 0
    || profile.banned_categories.length > 0;
}

function toEvidenceEntry(hit: FoodHit): Entry {
  return {
    foodRefId: hit.foodRefId, allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit),
    category: hit.category ?? null, onEatsList: hit.prefStatus === "eats",
    onAvoidList: hit.prefStatus === "avoid", catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null,
  };
}

function inText(prose: string, name: string): boolean {
  const key = normalizeFoodText(name);
  return key !== "" && ` ${prose} `.includes(` ${key} `);
}

/**
 * The checked id behind a suggestion card: turn evidence, then a block's catalog-resolved id, then
 * a model id policy already blocks on (that card recommends nothing). Null: a model-only id.
 */
function checkedCardEntry(s: RawSuggestion, input: ReplyScanInput): Entry | null {
  const found = input.evidence[s.name];
  if (found && found.foodRefId !== null && (!s.foodRefId || s.foodRefId === found.foodRefId)) {
    return found;
  }
  // By id only: a card with no id of its own carries no checked id, whatever a block holds.
  const block = s.foodRefId ? input.blockFoods?.find((b) => b.foodRefId === s.foodRefId) : undefined;
  if (block) {
    // No facts came with a block's id, so its name alone may never clear it as a whole food
    // (Grok audit round 5).
    return { foodRefId: block.foodRefId, allergenTags: null, category: null,
      onEatsList: false, onAvoidList: false, packaged: true };
  }
  const card = cardEvidence(s, input.evidence);
  return checkItem({ ...card, name: s.name, grams: null }, input.profile).verdict === "blocked"
    ? card : null;
}

/** Named suggestions and turn evidence — the ids this turn already holds. */
function heldMentions(input: ReplyScanInput, prose: string, failing: ReplyFailure[]): Mention[] {
  const mentions: Mention[] = [];
  const namedKeys = new Set(input.named.map((s) => normalizeFoodText(s.name)));
  for (const s of input.named) {
    const entry = checkedCardEntry(s, input);
    // A card id the model wrote itself, with no search behind it, is not a checked id.
    if (entry === null) {
      failing.push({ name: s.name, reason: "unchecked_id" });
      continue;
    }
    mentions.push({ name: s.name, entry, named: true, inProse: inText(prose, s.name) });
  }
  for (const [name, entry] of Object.entries(input.evidence)) {
    if (!namedKeys.has(normalizeFoodText(name)) && inText(prose, name)) {
      mentions.push({ name, entry, named: false, inProse: true });
    }
  }
  return mentions;
}

/** The catalog searches the prose needs, started at once (round-4 audit #2): they run while the
 *  grounded log settles, so a slow grounding no longer spends the scan's budget first. */
type CatalogSearch = {
  holders: string[]; lexicon: string[]; sweep: string[]; shopping: string[];
  hits: Promise<[Settled<FoodHit[]>[], Settled<FoodHit[]>[], Settled<FoodHit[]>[]]>;
};

function startCatalogSearch(
  input: ReplyScanInput, ports: ReplyCheckPorts, deadlineAt: number,
): CatalogSearch {
  const heldNames = [...Object.keys(input.evidence), ...input.named.map((s) => s.name)];
  const holders: string[] = [];
  const lexicon: string[] = [];
  for (const phrase of lexiconMentions(input.text)) {
    const holder = heldNames.find((name) => hitNamesPhrase(name, phrase));
    if (holder === undefined) lexicon.push(phrase);
    else holders.push(holder);
  }
  // A meal slot named in the prose ("as a snack", "for lunch") is not a food to resolve.
  const exclude = new Set([...heldNames.map(normalizeFoodText), ...lexiconMentions(input.text),
    ...SLOT_WORDS]);
  const sweep = candidatePhrases(input.text, exclude);
  const search = (phrase: string) =>
    settleBy(ports.searchFoods(input.userId, phrase, SEARCH_LIMIT), deadlineAt);
  // Every shopping item is looked up too (DeepSeek audit round 9, HIGH): its confirmation sentence
  // and mirror card leave the scan, so the item itself must still meet the account's hard rules.
  const shopping = shoppingItemNames([...(input.actions ?? []), ...(input.pendingActions ?? [])]);
  const hits = Promise.all([Promise.all(lexicon.map(search)), Promise.all(sweep.map(search)),
    Promise.all(shopping.map(search))]);
  return { holders, lexicon, sweep, shopping, hits };
}

async function resolveByCatalog(
  started: CatalogSearch, input: ReplyScanInput, held: Mention[], failing: ReplyFailure[],
): Promise<{ mentions: Mention[]; complete: boolean }> {
  const mentions: Mention[] = [];
  // The prose names a food the turn already holds an id for: judge that id as named in prose. A
  // holder that is this turn's own logged food is in neither list and is not advice.
  for (const holder of started.holders) {
    const heldMention = held.find((m) => m.name === holder);
    if (heldMention) heldMention.inProse = true;
    else if (input.evidence[holder]) {
      mentions.push({ name: holder, entry: input.evidence[holder], named: false, inProse: true });
    }
  }
  const [lexiconHits, sweepHits, shoppingHits] = await started.hits;

  let complete = true;
  started.lexicon.forEach((phrase, i) => {
    const found = lexiconHits[i];
    if (!found.ok) {
      complete = false;
      return;
    }
    const hit = found.value.find((h) => hitNamesPhrase(h.name, phrase));
    if (!hit || hit.foodRefId === null) failing.push({ name: phrase, reason: null });
    else mentions.push({ name: phrase, entry: toEvidenceEntry(hit), named: false, inProse: true });
  });
  // The sweep is best effort: its phrases are not known to be foods until the catalog names one.
  // A rejected search is not "no match", though (round-4 audit #3): it re-asks like the lexicon's.
  started.sweep.forEach((phrase, i) => {
    const found = sweepHits[i];
    if (!found.ok) {
      complete = false;
      return;
    }
    const hit = found.value.find((h) => hitNamesPhrase(h.name, phrase));
    if (!hit) return;
    if (hit.foodRefId === null) failing.push({ name: phrase, reason: null });
    else mentions.push({ name: phrase, entry: toEvidenceEntry(hit), named: false, inProse: true });
  });
  // A shopping item the catalog does not know (paper towels) has nothing to clash with.
  started.shopping.forEach((name, i) => {
    const found = shoppingHits[i];
    if (!found.ok) {
      complete = false;
      return;
    }
    const hit = found.value.find((h) => hitNamesPhrase(h.name, name));
    if (hit && hit.foodRefId !== null) {
      mentions.push({ name, entry: toEvidenceEntry(hit), named: false, inProse: true, shopping: true });
    }
  });
  return { mentions, complete };
}

function judge(
  mention: Mention, profile: ConstraintProfile, legacyActive: boolean,
  rules: ProfileRuleSet | null, evidence: DietEvidence | undefined,
): ReplyFailure | null {
  const { name, entry } = mention;
  if (rules) {
    const marks = profileMarksFor(rules, name, entry.ingredientsText, evidence);
    const hit = marks.find((mark) => mark.outcome === "present");
    if (hit) return { name, reason: `rule:${hit.facet}` };
    // A shopping item is checked at the shelf: only a definite clash stops it going on the list.
    if (!mention.shopping && marks.some((mark) => mark.outcome === "unknown")) {
      return { name, reason: null };
    }
  }
  const verdict = checkItem({ ...entry, name, grams: null }, profile);
  // A blocked suggestion card the prose never names is already marked by the pure check.
  if (verdict.verdict === "blocked") {
    return !mention.named || mention.inProse ? { name, reason: verdict.reason } : null;
  }
  // With a legacy hard rule, an unverified food in the prose is not a checked one; a suggestion
  // card carries its own "Check the label" mark (§5).
  return legacyActive && verdict.verdict === "unverified" && !mention.named && !mention.shopping
    ? { name, reason: null } : null;
}

/** `groundedLogged`'s fallback: the model's raw, pre-grounding claim — every direct caller that
 *  never supplies a deferred (every test, `startReplyScan`'s other callers). */
function rawLoggedIdentities(input: ReplyScanInput): LoggedIdentities {
  const identities = loggedFoodIdentities(input.actions ?? []);
  for (const name of input.loggedNames ?? []) identities.names.add(name.toLowerCase());
  return identities;
}

/**
 * 2026-10-02 DeepSeek audit (finding #3): `groundedLogged`, when supplied, is the turn's actual
 * GROUNDED log identities and always wins outright — never merged with the raw claim, which is
 * exactly what let an advised-but-never-logged food ride the exemption. Absent entirely (a direct
 * caller with no deferred) falls back to the raw claim unchanged; present but not settled by
 * `deadlineAt` (grounding that never returns) exempts nothing rather than guessing.
 */
async function resolveLoggedIdentities(
  input: ReplyScanInput, deadlineAt: number,
): Promise<LoggedIdentities> {
  if (!input.groundedLogged) return rawLoggedIdentities(input);
  const settled = await settleBy(input.groundedLogged, deadlineAt);
  return settled.ok ? settled.value : { names: new Set(), refs: new Set() };
}

async function scan(
  input: ReplyScanInput, ports: ReplyCheckPorts, deadlineAt: number,
): Promise<ReplyScan> {
  const legacyActive = hasActiveHardRules(input.profile);
  const rulesRead = ports.profileRules
    ? await settleBy(ports.profileRules(input.userId), deadlineAt)
    : { ok: true as const, value: null };
  const rules = rulesRead.ok && rulesRead.value && rulesRead.value.items.length > 0
    ? rulesRead.value : null;
  const incomplete: ReplyScan = { hardRulesActive: true, complete: false, failing: [] };
  // Owner ruling 2026-10-02: religious and other profile hard rules fail safe. A read that errors
  // or never answers cannot prove the account has none, so it re-asks; only a read that answered
  // with no rules lets an account without legacy rules skip the scan.
  if (!rulesRead.ok) return incomplete;
  if (!legacyActive && rules === null) return { hardRulesActive: false, complete: true, failing: [] };

  const failing: ReplyFailure[] = [];
  const prose = normalizeFoodText(input.text);
  // finding #6 / live smoke 2026-10-02: the model mirrors a food it logs into `suggestions`, which
  // made the user's own record fail as an unchecked card. Logged foods are not advice.
  // finding #3 (2026-10-02 DeepSeek audit): resolved from the GROUNDED log, not the model's raw
  // pre-grounding claim — see resolveLoggedIdentities above.
  const searching = startCatalogSearch(input, ports, deadlineAt);
  searching.hits.catch(() => {});
  const logged = await resolveLoggedIdentities(input, deadlineAt);
  // A card mirrors a logged food only when it carries no id of its own or that food's id (Grok
  // audit round 12): a card named like the log but holding another id is advice, and is judged.
  const mirrorsLog = (s: RawSuggestion) => logged.names.has(s.name.toLowerCase())
    && (!s.foodRefId || logged.refs.has(s.foodRefId));
  const advised = { ...input, named: input.named.filter((s) => !mirrorsLog(s)) };
  const held = heldMentions(advised, prose, failing);
  const live = await resolveByCatalog(searching, advised, held, failing);
  const mentions = [...held, ...live.mentions];

  let evidence = new Map<string, DietEvidence>();
  if (rules) {
    const foods: FacetFood[] = mentions.flatMap(({ entry }) => entry.foodRefId === null ? []
      : [{ foodRefId: entry.foodRefId, catalogFoodRevisionId: entry.catalogFoodRevisionId ?? null }]);
    const resolved = await resolveProfileEvidence(input.userId, foods, rules, ports, deadlineAt);
    if (resolved === null) return { ...incomplete, failing };
    evidence = resolved;
  }
  // finding #6: a food this turn's own log_meal already logged is the user's record of what they
  // ate, not advice — exempt from the hard-rule judgment below, by name or by its grounded id.
  for (const mention of mentions) {
    // A logged food is exempt as a record; putting it on the list is still judged.
    if (!mention.shopping && (logged.names.has(mention.name.toLowerCase())
      || (mention.entry.foodRefId !== null && logged.refs.has(mention.entry.foodRefId)))) continue;
    const evidenceFor = mention.entry.foodRefId === null ? undefined
      : evidence.get(mention.entry.foodRefId);
    const failure = judge(mention, input.profile, legacyActive, rules, evidenceFor);
    if (failure) failing.push(failure);
  }
  return { hardRulesActive: true, complete: live.complete, failing };
}

/**
 * Starts the scan now and never rejects: a thrown port, a rejected search or the deadline all
 * resolve as an incomplete scan, which fails closed exactly when a hard rule is known to exist.
 */
export function startReplyScan(
  input: ReplyScanInput, ports: ReplyCheckPorts, deadlineAt: number,
): Promise<ReplyScan> {
  // The reply's own "added X to your list" sentences are not advice (lib/coach/shopping-confirmation.ts).
  input = { ...input, text: withoutShoppingConfirmations(input.text,
    [...(input.actions ?? []), ...(input.pendingActions ?? [])]) };
  const legacyActive = hasActiveHardRules(input.profile);
  // A scan that never finishes cannot prove a profile rule is absent either (owner ruling above).
  const fallback: ReplyScan = { hardRulesActive: legacyActive || ports.profileRules !== undefined,
    complete: false, failing: [] };
  return settleBy(scan(input, ports, deadlineAt), deadlineAt)
    .then((settled) => settled.ok ? settled.value : fallback);
}

/**
 * §6 "replaces the reply with a safe re-ask": the reply, not the verdicts. A card policy blocked
 * (by a legacy rule, or a profile rule this scan found) stays on screen as blocked with its
 * reason (Phase 7); every other card goes, because a re-ask carries no food advice (§9 R7).
 */
function reask(base: ReplyCheckResult, failures: readonly ReplyFailure[]): ReplyCheckResult {
  const seen = new Set(base.textChecks.map((c) => c.name));
  const extra: CoachSuggestion[] = failures.filter((f) => !seen.has(f.name)).map((f) => ({
    foodRefId: null, name: f.name, grams: null, reason: f.reason, verdict: "blocked" as const,
  }));
  const ruleHits = new Map(failures.flatMap((f) =>
    f.reason?.startsWith("rule:") ? [[normalizeFoodText(f.name), f.reason] as const] : []));
  const suggestions = base.suggestions.flatMap((s): CoachSuggestion[] => {
    if (s.verdict === "blocked") return [s];
    const rule = ruleHits.get(normalizeFoodText(s.name));
    return rule ? [{ ...s, reason: rule, verdict: "blocked" }] : [];
  });
  return {
    content: abortMessage("unverified_text_food"), suggestions, draft: null, actions: [],
    draftChecks: base.draftChecks, textChecks: [...base.textChecks, ...extra],
  };
}

/** The pure check, then the live scan's verdict: a hard hit or anything unresolved re-asks. */
export async function checkReplyLive(
  input: ReplyCheckInput, scanned: Promise<ReplyScan> | null,
): Promise<ReplyCheckResult> {
  const base = checkReply(input);
  if (!scanned) return base;
  const result = await scanned;
  if (!result.hardRulesActive || (result.complete && result.failing.length === 0)) return base;
  const failures = result.complete ? result.failing
    : [...result.failing, { name: "reply", reason: "reply_check_incomplete" }];
  return reask(base, failures);
}
