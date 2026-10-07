import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

type RuleId = keyof typeof RULES;
type AllowEntry = {
  followUpId: string;
  ruleId: RuleId;
  path: string;
  line: number;
  lineSha256: string;
  reason: string;
};

const RULES = {
  PERSON_NAME: /\b(?:\x53\x61\x73\x68\x61|\x44\x65\x76\x69\x6e)\b/i,
  THIRD_PERSON: /\b(?:\x73\x68\x65|\x68\x65\x72|\x68\x65\x72\x73|\x68\x65\x72\x73\x65\x6c\x66)\b/i,
  PERSONAL_KEY: /\bSASHA_(?:SYNC_TOKEN|USER_ID|MCP_TOKEN)\b/,
  PERSONAL_SYMBOL: /\b(?:SEED_FOODS|seedFoods|PRESET_FOODS|REMOVED_SEED|RAMP_TABLE|rampTargets|RampControl|DEFAULT_TRAINING_WEEKDAYS)\b/,
  PERSONAL_TZ: /America\/New_York|her[_ -]zone/i,
  CONTEXT_KEY: /\bher_(?:clock|lists|recipes)\b/i,
  SINGLETON: /\.eq\(\s*["']id["']\s*,\s*["']\x73\x61\x73\x68\x61["']\s*\)/i,
} as const;

const ROOT = process.cwd();
const ACTIVE_DOCS = ["AGENTS.md", "docs/architecture.md", "docs/features.md"];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(path))) return [];
    if (/(?:^|\/)tests?(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(path)) return [];
    return [path];
  });
}

function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

describe("tenant-neutral active source", () => {
  it("keeps original-client ritual slots out of account-facing plan surfaces", () => {
    const paths = [
      "app/page.tsx", "components/settings/ScheduleSection.tsx", "components/CoachComposedCard.tsx",
      "components/coach/editors/BarcodeDraftEditor.tsx", "components/coach/editors/CaptureDraftEditor.tsx",
      "lib/ics.ts", "lib/coach/prompt.ts", "lib/server/day-context.ts",
    ];
    const found = paths.filter((path) => /coffee|pouches-pre|post-refuel|hot.chocolate|pre.training carbs/i
      .test(readFileSync(join(ROOT, path), "utf8")));
    expect(found).toEqual([]);
  });

  it("names ritual slots outside the legacy modules only where saved data must stay readable", () => {
    // Spec phase 15 c2: every account uses its own Meal 1..N layout. Historical ritual slot ids stay
    // readable for explicitly saved data, so a file outside the legacy modules may name them only
    // for one of the reasons below. A new file needs a reason here, or it must not name them.
    const RITUAL = /coffee|pouches-pre|post-refuel|hot.chocolate|pre.training carbs/i;
    const LEGACY = new Set(["lib/meals.ts", "lib/rotation.ts", "lib/plan-legacy.ts"]);
    const SLOT_ALLOWLIST = "accepts saved historical slot ids";
    const SLOT_LABEL = "labels a saved historical slot";
    const FOOD_TEXT = "names a food or drink, not a slot";
    const READABLE: Record<string, string> = {
      "components/coach/blocks/log_draft.tsx": SLOT_ALLOWLIST,
      "components/LoggedExtras.tsx": SLOT_LABEL,
      "components/SlotCard.tsx": "documents the compact variant a saved ritual slot renders as",
      "components/week/WeekGrid.tsx": "keeps an optional saved slot from blocking a done day",
      "lib/catalog/category-map.ts": FOOD_TEXT,
      "lib/catalog-client.ts": FOOD_TEXT,
      "lib/food-db.ts": FOOD_TEXT,
      "lib/units.ts": FOOD_TEXT,
      "lib/coach/profile-synonyms.generated.ts": FOOD_TEXT,
      "lib/log/contract.ts": SLOT_ALLOWLIST,
      "lib/log/reconcile.ts": SLOT_ALLOWLIST,
      "lib/coach/apply-shared.ts": SLOT_LABEL,
      "lib/coach/apply-entries.ts": SLOT_ALLOWLIST,
      "lib/coach/actions/copy.ts": SLOT_LABEL,
      "lib/coach/attachments.ts": SLOT_ALLOWLIST,
      "lib/coach/intent.ts": "reads a request that names a saved historical slot",
      "lib/coach/intent-questions.ts": "describes a saved historical slot to the intent pass",
      "lib/coach/types.ts": SLOT_ALLOWLIST,
      "lib/sync/plan-days-schema.ts": SLOT_ALLOWLIST,
      "lib/today/calendar.ts": "keeps an optional saved slot from blocking a done day",
      "lib/capture/types.ts": SLOT_ALLOWLIST,
      "lib/resolve.ts": "shows a ritual slot only when saved data exists for it",
      "lib/types.ts": SLOT_ALLOWLIST,
    };
    const found = ["app", "components", "lib"].flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .map((path) => relative(ROOT, path))
      .filter((path) => !LEGACY.has(path) && RITUAL.test(readFileSync(join(ROOT, path), "utf8")));
    expect(found.filter((path) => !READABLE[path])).toEqual([]);
    // A stale reason is removed with the code it excused.
    expect(Object.keys(READABLE).filter((path) => !found.includes(path))).toEqual([]);
  });

  it("contains no personal defaults or singleton identifiers", () => {
    const paths = [
      ...sourceFiles(join(ROOT, "app")),
      ...sourceFiles(join(ROOT, "components")),
      ...sourceFiles(join(ROOT, "lib")),
      join(ROOT, "middleware.ts"),
      join(ROOT, ".env.example"),
      ...ACTIVE_DOCS.map((path) => join(ROOT, path)),
    ].filter(existsSync);
    const allow = JSON.parse(readFileSync(
      join(ROOT, "tests/tenancy/personal-defaults.allowlist.json"),
      "utf8",
    )) as AllowEntry[];
    const matchedAllow = new Set<number>();
    const failures: string[] = [];

    for (const [index, entry] of allow.entries()) {
      if (!entry.followUpId || !entry.reason || !RULES[entry.ruleId]) {
        failures.push(`invalid allowlist entry ${index + 1}`);
      }
    }

    for (const absolutePath of paths) {
      const path = relative(ROOT, absolutePath);
      const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
      lines.forEach((line, lineIndex) => {
        for (const [ruleId, rule] of Object.entries(RULES) as [RuleId, RegExp][]) {
          if (!rule.test(line)) continue;
          const lineNumber = lineIndex + 1;
          const hash = lineHash(line);
          const allowedIndex = allow.findIndex((entry) =>
            entry.ruleId === ruleId
            && entry.path === path
            && entry.line === lineNumber
            && entry.lineSha256 === hash,
          );
          if (allowedIndex >= 0) matchedAllow.add(allowedIndex);
          else failures.push(`${ruleId} ${path}:${lineNumber} ${line.trim()}`);
        }
      });
    }

    allow.forEach((entry, index) => {
      if (!matchedAllow.has(index)) failures.push(`stale allowlist entry ${index + 1}: ${entry.path}:${entry.line}`);
    });
    if (existsSync(join(ROOT, "docs/catalog/her-foods-mapping.csv"))) {
      failures.push("obsolete docs/catalog mapping CSV still exists");
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
