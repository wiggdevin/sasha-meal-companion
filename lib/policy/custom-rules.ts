/** Explicitly supported exclusions. Other free text stays guidance, never a safety claim. */
export type CustomRule = { id: string; kind: "ingredient" | "cuisine" | "guidance"; text: string };

export function isCustomRule(value: unknown): value is CustomRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(item.id)
    && (item.kind === "ingredient" || item.kind === "cuisine" || item.kind === "guidance")
    && typeof item.text === "string" && item.text === item.text.trim()
    && [...item.text].length >= 2 && item.text.length <= 80
    && !/[\u0000-\u001f\u007f]/u.test(item.text)
    && Object.keys(item).every((key) =>
      key === "id" || key === "kind" || key === "text");
}

/** Bad persisted rules must fail the read, never quietly become an empty allowed profile. */
export function parseCustomRules(value: unknown): CustomRule[] {
  if (!Array.isArray(value) || value.length > 30 || !value.every(isCustomRule)
    || new Set(value.map((rule) => rule.id)).size !== value.length) {
    throw new Error("Invalid stored custom food rules");
  }
  return value;
}

export function normalizeRuleText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .split(" ").map((word) => {
      if (word.length < 4 || word.endsWith("ss")) return word;
      if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
      if (word.endsWith("oes")) return word.slice(0, -2);
      if (/(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
      return word.endsWith("s") ? word.slice(0, -1) : word;
    }).join(" ");
}

export function matchesRule(value: string, rule: CustomRule): boolean {
  const wanted = normalizeRuleText(rule.text);
  if (!wanted) return false;
  return ` ${normalizeRuleText(value)} `.includes(` ${wanted} `);
}

export function ingredientRuleMatches(rule: CustomRule, names: readonly string[]): boolean {
  return isCustomRule(rule) && rule.kind === "ingredient" && names.some((name) => matchesRule(name, rule));
}

/** Names that can stand for a prepared food rather than one whole ingredient. */
export function mayHaveSubingredients(name: string): boolean {
  return /\b(?:crushed|canned|sauce|dressing|bread|paste|soup|spread|seasoned|mix|blend|prepared|marinated|stock|broth|sausage|yogurt|cheese|cereal|cracker|pasta|tofu|milk|butter|bar|powder)\b/i.test(name);
}
