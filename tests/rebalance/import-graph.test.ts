/**
 * Phase 19 R2 / §7 "Read-only": "Nothing under lib/rebalance/ imports lib/plan-day-client.ts,
 * lib/store.ts writers, lib/sync/* writers or lib/coach/actions/*." Checked as a full transitive
 * walk from every lib/rebalance/*.ts file (plus R1's lib/plan/panel-slots.ts, its sibling pure
 * projection) — so a writer reached through two hops is caught exactly as one reached directly.
 *
 * The UI files that use this data (the panel component, its widget face adapter, the widget-sync
 * hook and the Today navigation helper) get a lighter, direct-import check only: they sit inside
 * the ordinary component tree, which legitimately reaches storage code elsewhere in files such as
 * components/SlotCard.tsx for reasons that have nothing to do with the one pure helper
 * (`formatTime`) this panel imports from it — walking their whole transitive graph would flag code
 * no import here ever executes.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const DEEP_ENTRIES = [
  "lib/rebalance/panel-client.ts",
  "lib/rebalance/panel.ts",
  "lib/rebalance/copy.ts",
  "lib/rebalance/balance.ts",
  "lib/rebalance/classify.ts",
  "lib/rebalance/missed.ts",
  "lib/rebalance/intake.ts",
  "lib/plan/panel-slots.ts",
];

const SHALLOW_ENTRIES = [
  "components/today/RebalancePanel.tsx",
  "components/today/RebalancePanelFace.tsx",
  "lib/today/rebalance-widget.ts",
  "lib/today/open-slot-card.ts",
];

/** Whole-module bans: a writer path, root or not. */
const FORBIDDEN_MODULES = [
  "lib/plan-day-client",
  "lib/coach/actions/",
  "lib/log-commit-client",
  "lib/log-client",
  "lib/log-note-client",
  "lib/log-time-client",
  "lib/water-client",
  "lib/foods/prefs-client",
  "lib/health/weigh-in-client",
  "lib/sync/account-sync",
  "lib/sync/outbox",
  "lib/sync/idb",
  "lib/sync/plan-day-queue",
  "lib/sync/schedule-settings",
  "lib/sync/plan-days",
  "lib/sync/merge",
  "lib/sync/post-sync",
];

/**
 * lib/store.ts and lib/sync/client.ts each mix a read-only surface with writer code in the same
 * file. Only these names may be imported from them, and once every named import is one of them the
 * walk does not follow that module further: the writer code elsewhere in that file is never
 * reached by any call graph starting here.
 */
const SAFE_SYMBOL_MODULES: Record<string, Set<string>> = {
  "lib/store": new Set(["loadStore", "getDay", "defaultStore", "defaultSettings", "getFoods"]),
  "lib/sync/client": new Set(["SYNCED_EVENT"]),
};

type Import = { spec: string; names: string[]; typeOnly: boolean };

function moduleImports(file: string, source: string): Import[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Import[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly === true;
      const names: string[] = [];
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
        }
      }
      found.push({ spec: node.moduleSpecifier.text, names, typeOnly });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null;
  const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((extension) => `${base}${extension}`)
    .find((candidate) => existsSync(path.join(ROOT, candidate))) ?? null;
}

function baseOf(file: string, spec: string): string {
  return spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
}

function checkImport(file: string, imp: Import): string | null {
  if (imp.typeOnly) return null;
  const base = baseOf(file, imp.spec);
  if (FORBIDDEN_MODULES.some((prefix) => base === prefix || base.startsWith(prefix))) {
    return `${file} -> ${base}`;
  }
  const safeNames = SAFE_SYMBOL_MODULES[base];
  if (safeNames) {
    const unsafe = imp.names.filter((name) => !safeNames.has(name));
    if (unsafe.length > 0) return `${file} -> ${base}: ${unsafe.join(", ")}`;
  }
  return null;
}

function graphFrom(entry: string): { seen: Set<string>; offenders: string[] } {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const imp of moduleImports(file, source)) {
      // A type-only edge erases at compile time (same rule as tests/cards/inventory.test.ts "a
      // type-only edge is not a mount"): it can never execute a writer, so it is never walked.
      if (imp.typeOnly) continue;
      const offense = checkImport(file, imp);
      if (offense) { offenders.push(offense); continue; }
      const base = baseOf(file, imp.spec);
      // A module satisfied entirely by safe names is never walked into further (see above).
      if (SAFE_SYMBOL_MODULES[base]) continue;
      const resolved = resolveImport(file, imp.spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return { seen, offenders };
}

function directOffenders(file: string): string[] {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  return moduleImports(file, source).map((imp) => checkImport(file, imp))
    .filter((offense): offense is string => offense !== null);
}

describe("rebalance panel: read-only import graph", () => {
  it("imports no writer, directly or transitively, under lib/rebalance/", () => {
    for (const entry of DEEP_ENTRIES) {
      expect(existsSync(path.join(ROOT, entry)), `${entry} should exist`).toBe(true);
    }
    const offenders = DEEP_ENTRIES.flatMap((entry) => graphFrom(entry).offenders);
    expect(offenders).toEqual([]);
  }, 20_000);

  it("reaches a real graph, so the scan is not vacuous", () => {
    const { seen } = graphFrom("lib/rebalance/panel-client.ts");
    expect(seen.size).toBeGreaterThan(5);
  });

  it("finds no lib/rebalance/*.ts file not already a deep entry", () => {
    const files = readdirSync(path.join(ROOT, "lib/rebalance"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => `lib/rebalance/${name}`);
    for (const file of files) expect(DEEP_ENTRIES).toContain(file);
  });

  it("the UI files (panel, face adapter, widget sync, Today navigation) import no writer directly", () => {
    for (const entry of SHALLOW_ENTRIES) {
      expect(existsSync(path.join(ROOT, entry)), `${entry} should exist`).toBe(true);
    }
    const offenders = SHALLOW_ENTRIES.flatMap(directOffenders);
    expect(offenders).toEqual([]);
  });
});

/**
 * §7 "One predicate", widened past lib/rebalance/balance.test.ts's own directory to the UI files:
 * none of them may compare a kcal figure with a target themselves — every over/under/within
 * decision must already have been made by `classifyDay` (which calls `balanceOf`) before a UI file
 * ever sees it. A UI file only renders `panel.state`/`panel.tone`, already-decided strings.
 */
describe("rebalance panel: one predicate reaches the UI only as a decided state", () => {
  const KCAL = String.raw`(kcal|Kcal|recorded|planned|left|consumed)`;
  const TARGET = String.raw`(target|Target|\bT\b|toleranceFor|tolerance)`;
  const compare = new RegExp(`${KCAL}[^;\\n]*[<>]=?[^;\\n]*${TARGET}|${TARGET}[^;\\n]*[<>]=?[^;\\n]*${KCAL}`);

  it("finds no comparison of kcal with a target in the panel component, its face adapter, the widget sync or Today navigation", () => {
    for (const file of SHALLOW_ENTRIES) {
      const code = readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const lines = code.split("\n").filter((text) => compare.test(text.replace(/=>/g, " arrow ")));
      expect({ file, lines }).toEqual({ file, lines: [] });
      expect({ file, tolerance: /toleranceFor|BALANCE_TOLERANCE/.test(code) }).toEqual({ file, tolerance: false });
    }
  });

  it("the hook that drives state for the UI imports classifyDay, never deciding on its own", () => {
    const code = readFileSync(path.join(ROOT, "lib/rebalance/panel-client.ts"), "utf8");
    expect(/import\s*{[^}]*\bclassifyDay\b[^}]*}\s*from\s*"\.\/classify"/.test(code)).toBe(true);
    expect(/import\s*{[^}]*\bdayBalance\b[^}]*}\s*from\s*"\.\/balance"/.test(code)).toBe(true);
  });
});
