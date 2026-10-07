/**
 * Deterministic medical deflection — runs BEFORE the model call, so a medical question costs
 * zero model calls (acceptance criterion 7). targets.md §8 "Refer, do not prescribe": managing a
 * health condition belongs to the user's own clinician, never to this app.
 *
 * The patterns below still name conditions, because naming them is how a matcher recognises a
 * medical question. The REPLY names none: any account can ask one, so the copy may not assume a
 * diagnosis the user has not given (Grok pass 1).
 *
 * A pattern matcher over-deflects by design; spec open question 5 has the reviewer reviewing the false
 * positives from the manual gate. Every pattern carries an id so a review names the rule.
 *
 * Pure. No I/O, no Supabase import.
 */

export const MEDICAL_PATTERNS: readonly { id: string; re: RegExp }[] = Object.freeze([
  // `do i have` on its own matched "What do I have left to eat today?" and deflected it in 70 ms
  // with no model call at all — a food question answered as a medical one (panel round 2, item 1).
  // The named conditions are what makes it a diagnosis question; "do I have a flare" is its own
  // rule below.
  { id: "diagnosis", re: /\b(diagnose|diagnosis|is this a symptom|am i in remission|do i have (colitis|uc|ulcerative colitis|crohn ?s|ibd))\b/ },
  { id: "worsening", re: /\b(is|are) my (colitis|uc|ulcerative colitis|inflammation|gut|disease)\b/ },
  { id: "flare-severity", re: /\b(how (bad|severe)|severity of)\b.*\b(flare|colitis|symptoms?)\b/ },
  { id: "flare-now", re: /\b(do|am) i (have|having|in) a? ?flare\b/ },
  { id: "medication-name", re: /\b(mesalamine|mesalazine|azathioprine|prednisone|prednisolone|infliximab|adalimumab|vedolizumab|budesonide|sulfasalazine|ibuprofen|nsaid)\b/ },
  { id: "medication-generic", re: /\b(medication|medicine|prescription|prescribe)\b/ },
  { id: "dosage", re: /\b(dose|dosage|how much should i take|halve my|double my)\b/ },
  { id: "stop-start", re: /\bshould i (stop|start|quit|come off|go back on)\b/ },
  { id: "clinical-test", re: /\b(colonoscopy|biopsy|calprotectin|crp|endoscopy|blood test|scope)\b/ },
  { id: "blood", re: /\b(blood in (my )?(stool|poo|bm)|rectal bleeding|bleeding)\b/ },
  { id: "referral", re: /\b(see my (gi|doctor|consultant)|go to (the er|hospital))\b/ },
  { id: "deficiency", re: /\b(anaemia|anaemic|anemia|anemic|deficiency|deficient)\b/ },
  { id: "safety", re: /\bis it safe to (take|use)\b/ },
]);

/** Refer, do not prescribe — and name no condition, because every account reads the same line. */
export const MEDICAL_DEFLECTION =
  "That is a question for your doctor, not for me. I can help with what you eat — targets, "
  + "portions, the foods on your list — but I do not read symptoms, medication or test results. "
  + "Write it down and bring it to your next appointment, and call your doctor sooner if it is "
  + "getting worse.";

export function classifyMedical(text: string): { deflect: boolean; matched: string[] } {
  const normalised = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const matched = MEDICAL_PATTERNS.filter((p) => p.re.test(normalised)).map((p) => p.id);
  return { deflect: matched.length > 0, matched };
}
