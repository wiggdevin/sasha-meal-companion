/**
 * Phase 13 §5 and §9 R1/R2 (slice 2): allergen evidence and what it allows. Pure: no I/O.
 *
 * Three evidence levels per food revision and allergen:
 *   listed       the ingredient text, label or the food's own name names it, or a legacy tag says so.
 *   not_listed   a COMPLETE parsed ingredient list is present and names no form of it.
 *   no_evidence  no complete ingredient list is available (the default, and every legacy `[]`).
 *
 * For an allergen the account avoids:
 *   listed                          → blocked.
 *   not_listed, one of the nine
 *     allergens US law requires on
 *     labels (FALCPA + sesame)      → allowed: "No <allergen> listed on the label".
 *   not_listed, any other allergen  → unverified until the user marks that exact product checked
 *                                     (R1): a label need not declare it, and silence is not
 *                                     evidence.
 *   no_evidence                     → unverified: "Check the label", unless lib/policy/
 *                                     whole-foods.ts reads the name as a plain whole food (owner
 *                                     decision, 2026-10-02) — then every allergen NOT intrinsic to
 *                                     that food's class is allowed: "Plain <class> has no
 *                                     <allergen>". A stored listed/not_listed or a user's own
 *                                     check always wins; this only fills the gap below them.
 *   the user checked this product   → allowed: "You checked this label".
 *   a Jev-only listed (a hold)      → unverified, never lifted automatically (W2a, allergen-holds.ts).
 *
 * The food's own NAME is scanned with the same keyword table as the ingredient text (escalation by
 * name, same decision): "whey protein powder" blocks a dairy avoid with no ingredient text at all,
 * because the name itself says whey. A name only ever escalates toward listed, like a tag.
 * Cross-contact is never inferred from silence: labels need not warn about it, and the card says
 * so. The Eats list no longer clears an active allergen.
 */
import type { Facet } from "@/lib/foods/facet-vocabulary";
import { isCompleteLabelStatement } from "@/lib/policy/label-completeness";
import { classifyWholeFood, clearanceNameOf } from "@/lib/policy/whole-foods";
import { HELD_ALLERGEN_TEXT, isDeterministicListed } from "@/lib/policy/allergen-holds";
import { nameForScan } from "@/lib/policy/allergen-name";

export type AllergenLevel = "listed" | "not_listed" | "no_evidence";
/** `held` (W2a): a Jev-only `listed`, a hold; set only with `level: "listed"`, so it fails closed. */
export type StoredAllergenEvidence = { level: AllergenLevel; labelComplete: boolean; held?: true };

type AllergenRule = {
  label: string;
  /** One of the nine allergens US law requires on labels, with nothing outside them. */
  major: boolean;
  /** Whole-word ingredient forms. */
  keywords: readonly string[];
  /** Jev facets that once escalated it; W2a: read only by scripts/allergen-evidence-repair.ts. */
  facets: readonly Facet[];
  /** Phrases that contain a keyword but not the allergen ("cocoa butter"), removed first. */
  exclusions?: readonly string[];
};

/**
 * The account allergen keys (lib/reference.ts) plus the FALCPA names a rule may use. `gluten`
 * covers barley and rye, and `shellfish` covers molluscs, which US labels need not declare, so
 * neither can be cleared by silence (R1).
 */
export const ALLERGEN_RULES: Readonly<Record<string, AllergenRule>> = {
  dairy: { label: "dairy", major: true, facets: ["contains_dairy"], keywords: [
    "dairy", "milk", "milks", "cheese", "cheeses", "butter", "buttermilk", "cream", "whey", "casein",
    "caseinate", "caseinates", "butterfat", "yogurt", "yoghurt", "lactose", "ghee", "kefir",
    "curd", "curds", "lactalbumin", "lactoglobulin", "paneer", "ricotta", "mozzarella",
    "parmesan", "cheddar"], exclusions: [
    "cocoa butter", "cacao butter", "shea butter", "peanut butter", "nut butter",
    "almond butter", "cashew butter", "seed butter", "sesame butter", "apple butter",
    "cream of tartar", "coconut milk", "coconut cream", "almond milk", "oat milk", "soy milk",
    "soya milk", "rice milk", "cashew milk", "milk thistle", "butternut", "cream of wheat",
    "cream of rice"] },
  egg: { label: "egg", major: true, facets: ["contains_egg"], keywords: [
    "egg", "eggs", "albumen", "albumin", "ovalbumin", "lysozyme", "mayonnaise", "meringue",
    "yolk", "yolks"] },
  soy: { label: "soy", major: true, facets: ["contains_soy"], keywords: [
    "soy", "soya", "soybean", "soybeans", "tofu", "edamame", "tempeh", "miso", "tamari",
    "shoyu"] },
  // sol BLOCK (r5): "cacahuate"/"cacahuete" are the ordinary Spanish words for peanut — common on
  // real bilingual and Latin American labels. Recognizing the word directly here means a keyword
  // scan catches it regardless of what lib/policy/label-completeness.ts's lexicon does or does
  // not resolve that item's OTHER words to.
  peanut: { label: "peanut", major: true, facets: ["contains_peanut"], keywords: [
    "peanut", "peanuts", "groundnut", "groundnuts", "arachis", "cacahuate", "cacahuates",
    "cacahuete", "cacahuetes"] },
  "tree-nut": { label: "tree nuts", major: true, facets: ["contains_tree_nut"], keywords: [
    "almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan", "pecans",
    "pistachio", "pistachios", "hazelnut", "hazelnuts", "macadamia", "macadamias",
    "brazil nut", "brazil nuts", "pine nut", "pine nuts", "praline", "marzipan", "nut", "nuts",
    "filbert", "filberts"], exclusions: ["nutmeg", "butternut", "coconut", "doughnut",
    "donut", "peanut", "peanuts", "nut-free", "tiger nut", "tiger nuts"] },
  // finding #9 (superseded, review round 2, sol/FIX): fish_seafood's own rubric reads "true" for
  // shellfish too (facet-questions.ts — its "true" criteria literally lists shellfish as one of
  // the qualifying ingredients), so finding #9 suppressed the `fish` escalation whenever the more
  // specific `shellfish` facet was ALSO present, reasoning a shellfish-only food should not read
  // "Contains fish". That suppression could not tell a shellfish-only food apart from a food that
  // genuinely contains BOTH finfish and shellfish — the facets alone carry no such signal — so it
  // silently read a real fish-and-shellfish food as no_evidence for fish, leaving a fish-allergic
  // account with "unverified" (a soft "Check the label" mark) instead of the blocked `listed` R1
  // requires when no ingredient text is available to settle it. Jev only ever escalates and never
  // clears a food (§5), so between "may over-flag a shellfish-only food" and "may silently miss a
  // real fish ingredient", this now takes the escalation.
  fish: { label: "fish", major: true, facets: ["fish_seafood"],
    keywords: [
    "fish", "anchovy", "anchovies", "salmon", "tuna", "cod", "haddock", "pollock", "tilapia",
    "sardine", "sardines", "mackerel", "trout", "halibut", "bass", "herring", "catfish",
    "swordfish", "snapper", "flounder", "sole", "worcestershire"] },
  sesame: { label: "sesame", major: true, facets: ["contains_sesame"], keywords: [
    "sesame", "tahini", "tahina", "benne", "gingelly"] },
  wheat: { label: "wheat", major: true, facets: [], keywords: [
    "wheat", "spelt", "semolina", "durum", "farina", "farro", "couscous", "seitan", "bulgur",
    "kamut", "einkorn", "emmer", "triticale"] },
  // 2026-10-02: "gluten-free" is a claim, not a listing — the same shape tree-nut's own
  // "nut-free" exclusion already handles below. Without it, a name or label that says "Oats,
  // gluten-free" matched the bare keyword "gluten" and escalated straight to `listed`.
  gluten: { label: "gluten", major: false, facets: ["contains_gluten"], keywords: [
    "gluten", "wheat", "barley", "rye", "spelt", "malt", "semolina", "durum", "farina", "farro",
    "couscous", "seitan", "bulgur", "kamut", "einkorn", "emmer", "triticale"],
    exclusions: ["gluten-free", "gluten free"] },
  // finding #9: `shellfish` stays the combined, account-facing class (the picker's one "Shellfish"
  // chip, lib/reference.ts) with `major: false` — R1's "not_listed allows for the nine" never
  // applies here on its own, more cautious than the letter of R1, never less. FALCPA's actual
  // ninth major allergen is CRUSTACEAN shellfish specifically (shrimp, crab, lobster, crayfish,
  // krill) — molluscs (clam, mussel, oyster, scallop, squid, octopus) are not one of the nine.
  // `crustacean` below adds that allowance as its OWN evidence key, computed for every revision
  // alongside `shellfish`; `constraints.ts` includes its finding whenever the account avoids
  // `shellfish`, so a complete label naming no crustacean clears the crustacean-specific concern
  // even while the combined `shellfish` finding (mustard-style, non-major) stays exactly as it was.
  // Deliberately NOT wired into the account picker or EVIDENCE_KEYS's legacy alias table beyond a
  // narrow, one-off legacy-tag recovery (20261118090000_allergen_evidence.sql, the same pattern the
  // wheat/gluten recovery already uses) — an account still avoids one "Shellfish" setting.
  shellfish: { label: "shellfish", major: false, facets: ["shellfish"], keywords: [
    "shellfish", "crustacean", "crustaceans", "shrimp", "shrimps", "prawn", "prawns", "crab",
    "crabs", "lobster", "lobsters", "crayfish", "crawfish", "langoustine", "mussel", "mussels",
    "clam", "clams", "oyster", "oysters", "scallop", "scallops", "squid", "calamari", "octopus",
    "krill"] },
  // finding #9 (FIX): crustacean-only keywords, deliberately with NO facet escalation — Jev's
  // `shellfish` facet answers for the combined class (crustacean and mollusc alike), so applying it
  // here would over-flag a mollusc-only food as crustacean-listed. Text and legacy tags only.
  crustacean: { label: "crustacean shellfish", major: true, facets: [], keywords: [
    "crustacean", "crustaceans", "shrimp", "shrimps", "prawn", "prawns", "crab", "crabs", "lobster", "lobsters", "crayfish",
    "crawfish", "langoustine", "krill"] },
};

/**
 * Aliases for the same rule, so "milk" and "dairy" are one allergen.
 *
 * sol FIX (review round 1, phase 13 slice 2): "crustacean shellfish" is FALCPA's own name for the
 * ninth major allergen — exactly the `crustacean` rule's own `label` above — but used to alias to
 * the broader, non-major combined `shellfish` key instead. An account naming that specific major
 * allergen was then judged against the wrong rule: `major: false`, so R1's not_listed clearance
 * for one of the nine never applied, and the broader rule also (correctly, for ITS OWN purpose)
 * flags molluscs the account never actually named as an allergen. `crustaceans`/`molluscs` stay
 * mapped to the combined key: those are genuinely the broader class, not the FALCPA-specific name.
 */
const ALIASES: Readonly<Record<string, string>> = {
  milk: "dairy", lactose: "dairy", eggs: "egg", soya: "soy", soybean: "soy", soybeans: "soy",
  peanuts: "peanut", "tree nuts": "tree-nut", "tree nut": "tree-nut", tree_nut: "tree-nut",
  nuts: "tree-nut", "sesame-seeds": "sesame", "crustacean shellfish": "crustacean",
  crustaceans: "shellfish", molluscs: "shellfish",
};

export function allergenKey(name: string): string {
  const key = name.toLowerCase().trim();
  return ALIASES[key] ?? key;
}

/**
 * The rule for an allergen key. A name outside the table (an account-defined allergen such as
 * "mustard") is matched deterministically against the ingredient text by its own name, is never
 * sent to Jev (§9 R4), and is never one of the nine.
 */
export function allergenRule(name: string): AllergenRule {
  const key = allergenKey(name);
  const known = ALLERGEN_RULES[key];
  if (known) return known;
  const plural = key.endsWith("s") ? key.slice(0, -1) : `${key}s`;
  return { label: key, major: false, keywords: [key, plural], facets: [] };
}

/** The allergen keys every revision's evidence is computed and stored for. */
export const EVIDENCE_KEYS = Object.keys(ALLERGEN_RULES);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the text names any whole-word form of the allergen. */
export function textNames(name: string, text: string | null | undefined): boolean {
  if (!text || text.trim() === "") return false;
  const rule = allergenRule(name);
  const lower = (rule.exclusions ?? []).reduce(
    (current, phrase) => current.replaceAll(phrase, " "), text.toLowerCase());
  return rule.keywords.some((word) =>
    new RegExp(`(^|[^a-z])${escape(word)}([^a-z]|$)`).test(lower));
}

/**
 * finding #10 (r4 BLOCK, follow-up): a LISTED-only keyword scan over arbitrary text (parsed
 * ingredient NAMES, not necessarily the revision's verbatim printed statement) — for a caller
 * with no verbatim raw_text to read completeness from, but whose parsed rows still name an
 * allergen (e.g. a "peanut" ingredient row with no explicit allergen_tags entry). Never pass this
 * text to `looksLikeCompleteList`/`deriveEvidence`'s `labelComplete`: a joined list of names is
 * not the printed label this parser's crop guard was built to read, and judging completeness from
 * it would reopen the exact lossy-join escalation finding #10's own fix (lib/server/catalog.ts,
 * lib/server/coach.ts) closed. Only ever strengthens a verdict toward `listed`, never clears one.
 *
 * Checks the fixed EVIDENCE_KEYS vocabulary plus `extraKeys` — an account's own named allergens
 * (e.g. "mustard"), matched deterministically the same way a stored tag already is
 * (`allergenRule`'s fallback for a name outside the table) and otherwise invisible to
 * EVIDENCE_KEYS alone.
 */
export function namedAllergenHints(
  text: string | null | undefined, extraKeys: readonly string[] = [],
): string[] {
  const keys = [...new Set([...EVIDENCE_KEYS, ...extraKeys.map(allergenKey)])];
  return keys.filter((key) => textNames(key, text));
}

/**
 * One revision's evidence for one allergen, from deterministic inputs only (W2a: never Jev): its
 * ingredient text, whether that is the complete printed list, its legacy tags and the food's name.
 */
export function deriveEvidence(name: string, input: {
  ingredientsText: string | null | undefined;
  labelComplete: boolean;
  tags?: readonly string[] | null;
  /**
   * 2026-10-02 (owner decision, escalation by name): the food's own name, scanned with the same
   * keyword table as `ingredientsText` — "Protein powder, whey based" names no allergen in its
   * (empty) ingredient text, but the name itself says whey. Only ever strengthens toward `listed`.
   */
  foodName?: string | null;
}): StoredAllergenEvidence {
  const key = allergenKey(name);
  const tagged = (input.tags ?? []).some((tag) => tagCovers(tag, key));
  const hasText = typeof input.ingredientsText === "string" && input.ingredientsText.trim() !== "";
  const labelComplete = hasText && input.labelComplete;
  if (tagged || textNames(key, input.ingredientsText) || textNames(key, nameForScan(input.foodName))) {
    return { level: "listed", labelComplete };
  }
  return { level: labelComplete ? "not_listed" : "no_evidence", labelComplete };
}

/** W014 (A026): a class tag (OFF `en:crustaceans`, a bare `shellfish`) cannot rule crustaceans out. */
const CRUSTACEAN_CLASS_TAGS = new Set(["crustacean", "crustaceans", "shellfish"]);
const tagCovers = (tag: string, key: string): boolean => allergenKey(tag) === key
  || (key === "crustacean" && CRUSTACEAN_CLASS_TAGS.has(tag.toLowerCase().trim().replace(/^en:/, "")));

/** Two sources' evidence for one revision: a deterministic listed, then a hold (W2a), then the list. */
export function mergeEvidence(
  a: StoredAllergenEvidence | undefined, b: StoredAllergenEvidence | undefined,
): StoredAllergenEvidence | undefined {
  if (!a || !b) return a ?? b;
  if (isDeterministicListed(a) || isDeterministicListed(b)) {
    return { level: "listed", labelComplete: a.labelComplete || b.labelComplete };
  }
  if (a.held || b.held) {
    return { level: "listed", labelComplete: a.labelComplete || b.labelComplete, held: true };
  }
  if (a.level === "not_listed" || b.level === "not_listed") {
    return { level: "not_listed", labelComplete: true };
  }
  return { level: "no_evidence", labelComplete: false };
}

/**
 * finding #2: a THIS-READ evidence map (a scanned barcode label, a label capture matched to a
 * catalog revision) merged with a revision's STORED evidence, key by key. A fresh read of a label
 * must never discard what an earlier warm or Jev pass already found — a complete label that omits
 * an allergen the revision was already marked `listed` for must still read as blocked. Shared by
 * lib/server/barcode-policy.ts (the scanned-label path) and lib/server/capture.ts (a label capture
 * grounded to a catalog revision), so the two can never again disagree about the merge.
 */
/**
 * finding #9: avoiding the combined `shellfish` key implies caring about the FALCPA-major
 * crustacean allergen specifically too — the account picker (lib/reference.ts) exposes only the
 * one combined "Shellfish" chip, with no separate way to avoid crustacean. Every caller that turns
 * an account's own avoided-allergen list into the full set of keys to JUDGE (a finding) or RECORD
 * (a label check) expands it the same way here, so a check of the product's one label covers both.
 *
 * r4 BLOCK #2 (follow-up): normalizes via `allergenKey` itself, rather than trusting the caller
 * to have done so first — a raw profile row can read `"Shellfish "` (case, whitespace) and an
 * unnormalized `.includes("shellfish")` silently missed it, dropping the stored crustacean
 * evidence a fresh read's own text did not happen to repeat.
 */
export function withCrustaceanAllowance(keys: readonly string[]): string[] {
  const normalized = [...new Set(keys.map(allergenKey))];
  return normalized.includes("shellfish") && !normalized.includes("crustacean")
    ? [...normalized, "crustacean"] : normalized;
}

export function mergeStoredEvidence(
  live: Readonly<Record<string, StoredAllergenEvidence>>,
  stored: Readonly<Record<string, StoredAllergenEvidence>>,
): Record<string, StoredAllergenEvidence> {
  return Object.fromEntries(Object.entries(live).map(([key, value]) =>
    [key, mergeEvidence(stored[allergenKey(key)], value) ?? value]));
}

export type AllergenFinding = {
  allergen: string;
  outcome: "present" | "absent" | "unknown";
  /** Why, in the words the card shows. Never "safe". */
  text: string;
  /** Whether a product check by the user would change this finding. */
  checkable: boolean;
};

/** What the card says under an allowed or unverified allergen: cross-contact is never cleared. */
export const CROSS_CONTACT_NOTE =
  "Labels do not have to warn about cross-contact, so check with the maker if that matters to you.";

/**
 * The finding for one active allergen rule on one food. `stored` is the revision's stored
 * evidence (absent means no_evidence); tags, the name and ingredient text may only ADD evidence
 * on top of it, via the same monotonic merge the stored row itself uses — never remove it.
 *
 * finding #3 r3 FIX: this used to force `labelComplete: false` on the live read, so search and
 * detail (which pass real ingredient text straight from the revision) could only ever derive
 * `listed`, never `not_listed` — a complete, allergen-free catalog label stayed unverified until a
 * separate warm pass ran and stored the same text's completeness on its behalf. The live read now
 * judges completeness itself (`looksLikeCompleteList`), so a genuinely complete label clears a
 * major allergen immediately; `mergeEvidence` keeps the merge monotonic either way.
 */
export function allergenFinding(name: string, input: {
  stored?: StoredAllergenEvidence;
  tags?: readonly string[] | null;
  ingredientsText?: string | null;
  userChecked?: boolean;
  /**
   * sol BLOCK (r5): whether `ingredientsText` is a genuine printed/scanned label — the only thing
   * §9 R1's completeness rule was built to read. Defaults to true, so every existing caller
   * (search, detail, a barcode or label scan) keeps its current behavior. A self-authored CUSTOM
   * food's own editable text is not a label at all (facet-warm.ts's warm path already gates its
   * OWN completeness the same way: "a client-created custom food is never a complete label; a
   * label scan may be") — pass `false` for that text so it may still ESCALATE a finding to
   * `listed` (it can genuinely name an allergen) but can never look "complete" enough to CLEAR
   * one; only an explicit label check (`userChecked`) can do that for such a food.
   */
  isLabelText?: boolean;
  /** 2026-10-02: the food's own name — escalation by name above, whole-food clearance below. */
  foodName?: string | null;
  /** 2026-10-02: the food's own brand. A branded row never gets whole-food clearance (below). */
  brand?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (HIGH, finding #2): true for a scanned barcode or label lane —
   * packaged by definition, whether or not this row's own `brand` string is set.
   */
  packaged?: boolean; wholeFoodName?: string | null; // 2026-10-03: see whole-foods.ts clearanceNameOf
}): AllergenFinding {
  const key = allergenKey(name);
  const rule = allergenRule(key);
  // r4 BLOCK "Also FIX": a single recognized word with nothing else ("Water") is a plausible
  // deliberately-short WAREHOUSED label (facet-warm.ts, catalog-ingredients.ts already store it
  // that way with an explicit, audited completeness flag) but is too thin a signal to let a LIVE
  // read of arbitrary ingredient text clear a major allergen with zero stored corroboration —
  // reproduced: a thin/wrong ingredientsText value reading "Water" would clear dairy outright.
  // Search and detail's own live derivation requires 2+ items (a terminated list) instead.
  const live = deriveEvidence(key, { ingredientsText: input.ingredientsText,
    labelComplete: looksLikeCompleteList(input.ingredientsText,
      { verbatim: input.isLabelText !== false }),
    tags: input.tags, foodName: input.foodName });
  const evidence = mergeEvidence(input.stored, live)
    ?? { level: "no_evidence", labelComplete: false };
  if (evidence.level === "listed" && evidence.held) {
    // W2a: a hold outranks the user's check, a complete label and the whole-food class below.
    return { allergen: key, outcome: "unknown", text: HELD_ALLERGEN_TEXT, checkable: false };
  }
  if (evidence.level === "listed") {
    return { allergen: key, outcome: "present", text: `Contains ${rule.label}`, checkable: false };
  }
  if (input.userChecked) {
    return { allergen: key, outcome: "absent", text: `You checked this label for ${rule.label}`,
      checkable: false };
  }
  if (evidence.level === "not_listed" && rule.major) {
    return { allergen: key, outcome: "absent", text: `No ${rule.label} listed on the label`,
      checkable: false };
  }
  if (evidence.level === "not_listed") {
    return { allergen: key, outcome: "unknown", checkable: true,
      text: `No ${rule.label} listed, but labels need not declare it. Check with the maker`
        + " and mark this product checked" };
  }
  // 2026-10-02: no evidence at all is the one gap a plain whole food can fill — a stored
  // `listed`, a label's `not_listed`, and the user's own check all already returned above.
  const wholeFood = classifyWholeFood({
    foodName: clearanceNameOf(input), brand: input.brand, ingredientsText: input.ingredientsText,
    packaged: input.packaged,
  });
  if (wholeFood && !wholeFood.intrinsic.includes(key)) {
    return { allergen: key, outcome: "absent", checkable: false,
      text: `Plain ${wholeFood.label} has no ${rule.label}` };
  }
  return { allergen: key, outcome: "unknown", text: `Check the label for ${rule.label}`,
    checkable: true };
}

/**
 * ORCHESTRATOR RULING (round 7): thin wrapper over the one strict predicate
 * (lib/policy/label-completeness.ts) every allergen-evidence path shares. Supersedes the earlier
 * majority-vote check (finding #3/#4, r4 and r4-followup, review round 2) — every word of every
 * item must resolve now, not most of them, there is no single-item exemption any more (a bare
 * "Water" never clears, on any path), and text that is not the label's own verbatim statement can
 * never read as complete regardless of shape. `verbatim` defaults to `true`: every existing caller
 * already passes real label text (a printed statement, a scan, a typed entry) straight through.
 */
export function looksLikeCompleteList(
  text: string | null | undefined, opts: { verbatim?: boolean; lossy?: boolean } = {},
): boolean {
  return isCompleteLabelStatement({
    text, verbatim: opts.verbatim ?? true, lossy: opts.lossy,
  });
}

/** Evidence for every stored allergen key from one revision's inputs. */
export function evidenceFromInputs(input: {
  ingredientsText: string | null | undefined;
  labelComplete: boolean;
  tags?: readonly string[] | null;
  foodName?: string | null;
}): Record<string, StoredAllergenEvidence> {
  return Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, deriveEvidence(key, input)]));
}

/**
 * Evidence per avoided allergen from one printed label's ingredient text (capture, barcode).
 * `verbatim` defaults to `true` — a scan or typed entry is the label's own text by definition —
 * but a caller reading a catalog revision's text (e.g. lib/server/barcode.ts, off a cached match)
 * passes what lib/foods/catalog-ingredients.ts completenessText actually found: `false` when the
 * row shape did not hold the single verbatim statement it expects.
 */
export function labelEvidence(
  avoided: readonly string[], text: string | null | undefined, tags?: readonly string[] | null,
  opts: { verbatim?: boolean } = {},
): Record<string, StoredAllergenEvidence> {
  const labelComplete = looksLikeCompleteList(text, { verbatim: opts.verbatim ?? true });
  return Object.fromEntries([...new Set(avoided.map(allergenKey))].map((key) =>
    [key, deriveEvidence(key, { ingredientsText: text, labelComplete, tags })]));
}

/**
 * The capture card's lines for a scanned label, one per avoided allergen (§5).
 *
 * Review round 2 (sol/BLOCK): `revisionEvidence` — the SAME stored evidence the item's own verdict
 * merges in (lib/server/capture.ts groundItem, mergeStoredEvidence) — is folded in here too, when
 * the caller has it (a label capture that grounded to a catalog revision). Without it, this read
 * the fresh OCR scan alone: a revision Jev or an earlier scan had already marked `listed` for an
 * allergen the CURRENT photo's text happens to omit blocked the item (the verdict merges `stored`)
 * while this card, right beside it, said "No <allergen> listed on the label" — the two surfaces
 * disagreeing about the same food from the same request.
 *
 * sol FIX (review round 1, finding #7): `checkedAllergens` — the SAME "I checked the label" mark
 * the item's own verdict already reads (groundItem's `evaluatePolicy` call gets
 * `checkedAllergens: checked`) — must reach this card's own findings too, or a prior check could
 * make the item's own verdict `allowed` while this card, right beside it, still said "Check the
 * label for X".
 */
export function labelFindings(
  avoided: readonly string[], text: string | null | undefined,
  revisionEvidence?: Readonly<Record<string, StoredAllergenEvidence>>,
  checkedAllergens?: readonly string[],
  /**
   * round 13, item 3: the SAME merged tags (catalog structured `allergen_tags` plus this label's
   * own OCR-derived tags) the item's own verdict already folds in — without them, a revision whose
   * structured tag the verdict caught (grounding blocks it) but whose background evidence warm has
   * not stored yet left this card reading the fresh OCR text alone, and a complete-but-omits-the-
   * allergen photo said "No <allergen> listed on the label" right beside a blocked item.
   */
  tags?: readonly string[] | null,
): AllergenFinding[] {
  const live = labelEvidence(withCrustaceanAllowance(avoided), text, tags);
  const evidence = revisionEvidence ? mergeStoredEvidence(live, revisionEvidence) : live;
  const checked = new Set((checkedAllergens ?? []).map(allergenKey));
  return Object.entries(evidence).map(([key, stored]) =>
    allergenFinding(key, { stored, ingredientsText: text, userChecked: checked.has(key) }));
}
