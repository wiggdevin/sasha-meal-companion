/**
 * Pure scoring for scripts/eval/lane-bench.ts: latency percentiles, accuracy per fixture, the
 * §3.2 selection rule with the §7 gates, and the report. Unit-tested in
 * tests/eval/lane-bench-score.test.ts; the bench itself never runs in CI because it bills real
 * projects (Phase 13 §3.2).
 */

/** Case-specific expectations: exact values, not substrings (Sol r1 finding 4). */
export type Expect =
  | { number: number; tolerance?: number }
  | { boolean: boolean }
  | { word: string }
  | { chart: "kcal_week" | "macros_today" | "weight_trend"; points: [string, number][];
      unit: string; label: string[] }
  | { replies: { allowed: string[]; include: string[] } }
  /**
   * `labels`: one entry per expected food, each entry either the one accepted word or (for an
   * inflection a plain "add an s" cannot reach, e.g. oat/oatmeal) every accepted spelling. Loose
   * substring matching let "eggplant" count as "egg" (r4 finding); words are matched whole.
   * `qty`: the expected serving count for the food at the same index, when the fixture states one
   * — left out (or `undefined` at that index) when the source text does not (r4 finding). This is
   * the production `qty` field (a count, capped at 100 — lib/ai/schemas.ts): never grams.
   * `grams`: the expected gram weight for the food at the same index, when the fixture states
   * one, checked against the production `grams` field within a generous estimation tolerance
   * (GPT-6 Sol review round 2: scoring checked the label and `qty` count but never `grams`, so an
   * extraction off by an order of magnitude — "two kilograms of eggs" for "two eggs" — still
   * scored correct).
   */
  | { labels: (string | string[])[]; items?: number; qty?: (number | undefined)[];
      grams?: (number | undefined)[] };

export type Attempt = {
  lane: string; model: string; caseId: string;
  latencyMs: number; schemaValid: boolean; correct: boolean;
  /** null when the provider's usage is unknown (a failed call): never counted as zero. */
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
  /** A closed failure code (timeout, schema_invalid, http_503, …), never provider text. */
  errorCode?: string;
};

export type LaneRow = {
  lane: string; model: string; n: number;
  p50Ms: number; p95Ms: number; schemaValidRate: number; accuracy: number;
  /** Cost of the calls whose usage is known, and how many calls had unknown usage. */
  costUsd: number; costPerCallUsd: number; unknownCost: number;
};

/** Nearest-rank percentile over the recorded latencies. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

const record = (value: unknown): Record<string, unknown> =>
  (typeof value === "object" && value !== null ? value as Record<string, unknown> : {});

/** Digits inside plain text, thousands separators collapsed, positions preserved (r4 finding 8:
 *  a caption's numbers must be attributed to a position, not just pooled into a value set). */
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
function numbersWithIndex(text: string): { value: number; index: number }[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => ({ value: Number(m[0].replace(/,/g, "")), index: m.index ?? 0 }));
}
const numbers = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

type ChartExpect = Extract<Expect, { chart: unknown }>;

/** Every (case-insensitive, substring) occurrence of `needle` in `haystack`, by index — not just
 *  the first (r1 review round 1 finding: a label restated later in the caption, falsely, must be
 *  checked at its own position too, not silently ignored past its first mention). */
function allOccurrences(haystack: string, needle: string): number[] {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return [];
  const out: number[] = [];
  for (let from = h.indexOf(n); from !== -1; from = h.indexOf(n, from + 1)) out.push(from);
  return out;
}

/**
 * Whether every number the caption states can be attributed to the point it actually belongs to.
 * r4 finding 8: checking against a pooled `Set` of every expected y-value let a caption that
 * *swaps* which value belongs to which x-label still pass, because both numbers were "in the
 * set" somewhere. A caption that never names a point by its label (a plain range statement) is
 * not held to attribution at all — only that every number it states is a real value or an
 * x-label's own digit.
 *
 * Attribution pairs each label with a number by the order the two appear in the text, using two
 * FIFO queues: a label with no number yet waits in `pendingLabels`; a number with no label yet
 * waits in `pendingNumbers`. This reads "Mon was 1800" (label then value), "80.7 kg in W5" (value
 * then label), and the bunched "Mon, Tue, Wed: 1800, 2000, 2000" (every label, then every number,
 * paired in order) alike — a nearest-neighbour rule alone attributes every number in the bunched
 * form to Wed, the last label seen, rather than pairing the two lists one to one.
 *
 * GPT-6 Sol review round 1, BLOCK #4: every occurrence of a label is now its own event (not only
 * the first), so a caption that names the same label a second time — "Mon was 1800 kcal ... and
 * Mon was 2000 kcal too" — creates a real, checked pairing for that second mention, and a false
 * second claim is caught directly (line ~X below), rather than by the coarser "a leftover number
 * fails" rule this replaces. That coarser rule is gone: a number left over once every label
 * occurrence has been paired is a value the caption already stated correctly once (it passed the
 * invented-number check above) and is simply not tied to a specific point a second time — e.g.
 * restating Tue's own 2000 again in an unattributed closing remark — which is truthful, not a
 * false claim about a distinct point, and must not fail the caption.
 */
function chartCaptionAttributes(expect: ChartExpect, caption: string): boolean {
  const labelEvents = expect.points
    .flatMap(([x], i) => allOccurrences(caption, x).map((idx) => ({ kind: "label" as const, i, idx })));
  const found = numbersWithIndex(caption);
  const isY = (value: number) => expect.points.some(([, y]) => y === value);
  const isXDigit = (value: number) => expect.points.some(([x]) => numbers(x).includes(value));
  if (found.some(({ value }) => !isY(value) && !isXDigit(value))) return false; // an invented number
  if (labelEvents.length === 0) return true; // no point named by label: nothing to misattribute
  const valueEvents = found.filter(({ value }) => isY(value))
    .map((n) => ({ kind: "num" as const, value: n.value, idx: n.index }));
  const events = [...labelEvents, ...valueEvents].sort((a, b) => a.idx - b.idx);
  const pendingLabels: number[] = [];
  const pendingNumbers: number[] = [];
  for (const event of events) {
    if (event.kind === "label") {
      const value = pendingNumbers.shift();
      if (value !== undefined && expect.points[event.i][1] !== value) return false;
      if (value === undefined) pendingLabels.push(event.i);
    } else {
      const target = pendingLabels.shift();
      if (target !== undefined) {
        if (expect.points[target][1] !== event.value) return false;
      } else {
        pendingNumbers.push(event.value);
      }
    }
  }
  // A number left unpaired here already passed the invented-number check above (it is a real
  // y-value or x-digit) and every occurrence of every label has already had its chance to claim
  // it: it is a truthful restatement, not an unproven or false claim about a point.
  return true;
}

/** Rise and fall words a caption uses to narrate a trend between two named points (GPT-6 Sol
 *  review round 2: "Calories fell from Mon to Tue" for a Mon-to-Tue rise scored correct, because
 *  every check above is about VALUES, never a caption's own claimed DIRECTION). Narrow and
 *  explicit on purpose, matching this scorer's existing style of catching a reproduced
 *  adversarial shape rather than attempting general trend-language understanding. */
const RISE_WORDS = new Set(["rose", "rising", "climbed", "climbing", "increased", "increasing",
  "jumped", "grew", "growing", "up"]);
const FALL_WORDS = new Set(["fell", "falling", "dropped", "dropping", "decreased", "decreasing",
  "declined", "declining", "down"]);

/**
 * Whether every "<word> from <label> to <label>" trend claim the caption makes is true of the
 * fixture's own points. A claim that names two real points is checked directly; a caption that
 * never uses this shape (or names points this scorer cannot resolve) is not held to it — this is
 * a targeted check for a reproduced shape, not a general narrative-truth checker.
 */
function chartCaptionDirection(expect: ChartExpect, caption: string): boolean {
  const findPoint = (label: string) =>
    expect.points.find(([x]) => x.toLowerCase() === label.toLowerCase());
  for (const match of caption.toLowerCase().matchAll(/\b([a-z]+)\s+from\s+([a-z0-9]+)\s+to\s+([a-z0-9]+)/g)) {
    const [, verb, fromLabel, toLabel] = match;
    const rising = RISE_WORDS.has(verb);
    const falling = FALL_WORDS.has(verb);
    if (!rising && !falling) continue;
    const from = findPoint(fromLabel);
    const to = findPoint(toLabel);
    if (!from || !to) continue; // does not name two of this chart's own points: nothing to check
    if (rising && !(to[1] > from[1])) return false;
    if (falling && !(to[1] < from[1])) return false;
  }
  return true;
}

/** Whether `token` is `want`, or a bare "add an s" plural of it either way — the loosest
 *  inflection accepted without listing a spelling explicitly (irregular forms like oat/oatmeal
 *  need their own spelling listed: r4 finding). Shared by food-label and chart-series-label
 *  matching so both accept the same plain plurals. */
const wordMatches = (token: string, want: string): boolean => {
  const w = want.toLowerCase();
  return token === w || token === `${w}s` || `${token}s` === w;
};

/** Every accepted spelling of one expected food (r4 finding). */
const matchesFood = (tokens: string[], want: string): boolean =>
  tokens.some((t) => wordMatches(t, want));

/**
 * Whether a captured item's `grams` is close enough to the fixture's stated weight (GPT-6 Sol
 * review round 2: scoring never read `grams` at all, so a wrong-magnitude extraction — grams
 * misread as kilograms — scored correct on food label and count alone). Gram weight is a model
 * estimate, not an exact reading the way a stated `qty` count is, so a generous tolerance (the
 * larger of 10 g or 25 % of the stated weight) allows reasonable estimation slack while still
 * catching an order-of-magnitude miss.
 */
function gramsMatches(got: unknown, want: number): boolean {
  if (typeof got !== "number") return false;
  return Math.abs(got - want) <= Math.max(10, want * 0.25);
}

/** Qualifiers that reverse an otherwise-matching chart series label: this app charts calories
 *  eaten, never burned (there is no expenditure tracking), so "kcal burned" contains the accepted
 *  word "kcal" but names the opposite quantity. A loose substring or bare-plural match alone would
 *  accept it; the label is rejected outright when one of these appears, even once plurals are
 *  allowed (bug found alongside the pluralisation fix above). */
const CONTRADICTING_QUALIFIERS = ["burned", "burnt", "expended", "spent"];

/** Whether one schema-valid answer meets its fixture's labelled expectation, exactly. */
export function isCorrect(expect: Expect, answer: unknown): boolean {
  const value = record(answer).value;
  if ("number" in expect) {
    // The whole value must be one number ("2000" or "2,000"); "5500" or "550 kcal" is wrong.
    const text = typeof value === "number" ? String(value)
      : typeof value === "string" ? value.trim().replace(/(\d),(?=\d{3}\b)/g, "$1") : "";
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return false;
    return Math.abs(Number(text) - expect.number) <= (expect.tolerance ?? 0.5);
  }
  if ("boolean" in expect) {
    const flag = typeof value === "boolean" ? value
      : typeof value === "string" ? { true: true, false: false }[value.trim().toLowerCase()] : undefined;
    return flag === expect.boolean;
  }
  if ("word" in expect) {
    return typeof value === "string" && value.trim().toLowerCase() === expect.word.toLowerCase();
  }
  if ("chart" in expect) {
    // Sol r2 finding 8: every point must be the fixture's own label and value, in order.
    const block = record(answer);
    const series = Array.isArray(block.series) ? block.series : [];
    const points = Array.isArray(record(series[0]).points) ? record(series[0]).points as unknown[] : [];
    // Sol r3 finding 8: the unit, the series label and every number the caption states must be
    // true of the data as well, or a renderable block with a false caption scores correct.
    // r4 finding 8: the series label is matched as a whole word ("calories" is not "calorie" —
    // it is a different word, not a looser form of the same one), and the caption's numbers are
    // attributed to the point they claim, not merely pooled (see chartCaptionAttributes above).
    // A whole word still allows a bare plural ("Calories"/"Macros"), and a contradicting
    // qualifier ("kcal burned") is rejected even when an accepted word is also present.
    // GPT-6 Sol review round 1, BLOCK #4: the qualifier must be rejected wherever it can mislead
    // the person reading the block, which is the CAPTION they actually see, not only the series
    // label — a clean label ("Calories") next to a caption that says "Calories burned rose to
    // 2000 kcal" previously scored correct, because only the label was checked.
    const seriesLabelWords: string[] =
      String(record(series[0]).label ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
    const captionText = String(block.caption ?? "");
    const captionWords: string[] = captionText.toLowerCase().match(/[a-z]+/g) ?? [];
    return block.chart === expect.chart && series.length === 1
      && String(block.unit ?? "").trim().toLowerCase() === expect.unit.toLowerCase()
      && expect.label.some((word) => seriesLabelWords.some((t) => wordMatches(t, word)))
      && !CONTRADICTING_QUALIFIERS.some((bad) => seriesLabelWords.includes(bad) || captionWords.includes(bad))
      && chartCaptionAttributes(expect, captionText)
      && chartCaptionDirection(expect, captionText)
      && points.length === expect.points.length
      && expect.points.every(([x, y], index) => {
        const point = record(points[index]);
        return String(point.x).trim().toLowerCase() === x.toLowerCase()
          && typeof point.y === "number" && Math.abs(point.y - y) < 1e-9;
      });
  }
  if ("replies" in expect) {
    // Every option must be exactly one of the allowed choices, and the required ones present.
    const options = Array.isArray(record(answer).options) ? record(answer).options as unknown[] : [];
    const norm = (value: unknown) => String(value).trim().toLowerCase();
    const allowed = new Set(expect.replies.allowed.map(norm));
    const given = options.map(norm);
    return given.every((option) => allowed.has(option))
      && expect.replies.include.every((want) => given.includes(norm(want)));
  }
  // r4 finding: substring matching let "eggplant" count as "egg"; each expected food is now
  // matched by whole word (plus a plain plural), against a DISTINCT item, and its quantity is
  // checked wherever the fixture states one — a wrong food or a wrong amount no longer passes.
  const items = Array.isArray(record(answer).items) ? record(answer).items as unknown[] : [];
  const itemTokens = items.map((item) => String(record(item).label ?? "").toLowerCase().match(/[a-z]+/g) ?? []);
  const used = new Set<number>();
  const named = expect.labels.every((want, wantIndex) => {
    const alternatives = Array.isArray(want) ? want : [want];
    const index = itemTokens.findIndex((tokens, i) =>
      !used.has(i) && alternatives.some((word) => matchesFood(tokens, word)));
    if (index === -1) return false;
    used.add(index);
    const qty = expect.qty?.[wantIndex];
    if (qty !== undefined && record(items[index]).qty !== qty) return false;
    const grams = expect.grams?.[wantIndex];
    return grams === undefined || gramsMatches(record(items[index]).grams, grams);
  });
  return named && (expect.items === undefined || items.length === expect.items);
}

export function summarise(attempts: readonly Attempt[]): LaneRow[] {
  const groups = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.lane}\0${attempt.model}`;
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  return [...groups.values()].map((rows) => {
    const n = rows.length;
    const known = rows.filter((row) => row.costUsd !== null);
    const costUsd = known.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    return {
      lane: rows[0].lane, model: rows[0].model, n,
      p50Ms: percentile(rows.map((row) => row.latencyMs), 50),
      p95Ms: percentile(rows.map((row) => row.latencyMs), 95),
      schemaValidRate: rows.filter((row) => row.schemaValid).length / n,
      accuracy: rows.filter((row) => row.correct).length / n,
      costUsd, costPerCallUsd: known.length === 0 ? 0 : costUsd / known.length,
      unknownCost: n - known.length,
    };
  });
}

/**
 * The spec's rule (§3.2, DECIDED): a challenger takes a lane when it is at least as accurate and
 * faster (p95), or clearly more accurate (5 points or more) — but never past the lane's budget
 * (§3), and, for a lane under §7's gate (coach turn, capture), never with a higher p95.
 */
export function beatsIncumbent(
  challenger: LaneRow, incumbent: LaneRow,
  gates: { budgetMs: number | null; p95MustNotRise: boolean },
): boolean {
  // A model that renders less often, or answers nothing right, never takes a lane on speed.
  if (challenger.accuracy === 0 || challenger.schemaValidRate < incumbent.schemaValidRate) {
    return false;
  }
  if (gates.budgetMs !== null && challenger.p95Ms > gates.budgetMs) return false;
  if (gates.p95MustNotRise && challenger.p95Ms > incumbent.p95Ms) return false;
  if (challenger.accuracy >= incumbent.accuracy && challenger.p95Ms < incumbent.p95Ms) return true;
  return challenger.accuracy >= incumbent.accuracy + 0.05;
}

export function markdownReport(rows: readonly LaneRow[], meta: { date: string; runs: number }): string {
  const pct = (value: number) => `${Math.round(value * 100)} %`;
  const usd = (value: number) => `$${value.toFixed(5)}`;
  return [
    `# Lane bench — ${meta.date}`,
    "",
    `Phase 13 §3.2. ${meta.runs} run(s) per fixture. Synthetic D0/D1 fixtures only`
      + " (scripts/eval/lane-bench/fixtures.json). Latency is the wall clock of one model call from"
      + " this machine, under each lane's own deadline: it is not an end-to-end coach turn or"
      + " capture, so it is not §7 gate evidence. Cost counts every completed provider attempt"
      + " (including schema-rejected retries); calls with no known usage are counted apart.",
    "",
    "| Lane | Model | n | p50 ms | p95 ms | Schema-valid | Accuracy | Cost | Cost/call | Usage unknown |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.lane} | ${row.model} | ${row.n} | ${row.p50Ms} | ${row.p95Ms} | ${
      pct(row.schemaValidRate)} | ${pct(row.accuracy)} | ${usd(row.costUsd)} | ${
      usd(row.costPerCallUsd)} | ${row.unknownCost} |`),
    "",
  ].join("\n");
}
