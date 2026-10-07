/**
 * Design §8.4 — the card-reachability gate.
 *
 * It builds a STATIC import graph rooted at every Next.js route entry point, following literal
 * static and dynamic imports through `app/**`, `components/**` and `lib/**` with the TypeScript
 * parser, and resolving both relative and `@/` specifiers. A card-like file must then be reachable
 * from a route, or absent from the tree — an orphan like the two this run deleted (`EstimatorCard`,
 * `BodyDataCard`) is a defect, not a file to excuse.
 *
 * Three rules keep the graph honest, and each one closed a hole an earlier pass had:
 *
 * 1. **The roots are route files, not every `.tsx` under `app/`.** The glob is
 *    `app/**\/{page,layout,template,default,error,loading,not-found}.tsx` — the files Next.js
 *    itself mounts. Rooting at `app/**\/*.tsx` made every screen module its own root, so a screen
 *    no route imported still counted as mounted.
 * 2. **A type-only edge is not a mount.** `import type { X } from "./Card"` and
 *    `export type { X } from "./Card"` erase at compile time; the bundler never loads the module.
 *    Declarations marked `isTypeOnly`, and specifier lists whose every member is `isTypeOnly`, are
 *    skipped — so a card reached only by its own prop type reads as the orphan it is.
 * 3. **A named spec must assert the named state.** For every manifest state the spec has to carry
 *    that state's words inside an `it(` / `test(` / `describe(` title — including the case table of
 *    an `.each` run. A spec that merely mentions the card somewhere in its text is a decorative
 *    link, which is how states with no assertion behind them survived the last pass.
 *
 * The second half is the manifest (`tests/cards/manifest.ts`): every candidate names its states and
 * the one spec that renders them. There is no wildcard and no orphan allowlist by design — either
 * rule would let the next orphan through the way `grep` did.
 *
 * Offline, and fast: it reads the repository with `node:fs` and parses it once. The whole walk is
 * asserted to finish inside `BUDGET_MS`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { CARD_MANIFEST, type CardManifestEntry } from "./manifest";

const ROOT = path.resolve(__dirname, "../..");
/** The three trees the app's own modules live in. Nothing else can reach a card. */
const SOURCE_DIRS = ["app", "components", "lib"];
/** Tried in order when a specifier names a directory or leaves the extension off. */
const RESOLUTIONS = [".tsx", ".ts", "/index.tsx", "/index.ts"];
/** §8.4's candidate pattern, verbatim. */
const CANDIDATE =
  /(Card|Panel|Section|Prompt|Warning|Rings|Grid|DayStrip|LoggedExtras|AvoidRules|MyFoods|RecipesSection|.*Sheet)\.tsx$/;
/**
 * The graph's roots: `app/**\/{page,layout,template,default,error,loading,not-found}.tsx`, the
 * only file names Next.js mounts by itself. Every other file under `app/` has to be imported.
 */
const ROUTE_ENTRIES = new Set([
  "page", "layout", "template", "default", "error", "loading", "not-found",
]);
/** The gate runs on every branch; five seconds is the ceiling design §8.4 sets. */
const BUDGET_MS = 5_000;
/** `it`, `test` and `describe` — the three calls that put a title on an assertion. */
const TITLE_CALLEES = new Set(["it", "test", "describe"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  return out;
}

function isRouteEntry(file: string): boolean {
  return file.startsWith("app/") && file.endsWith(".tsx")
    && ROUTE_ENTRIES.has(path.posix.basename(file, ".tsx"));
}

function resolver(files: Set<string>) {
  return (specifier: string, from: string): string | null => {
    let base: string;
    if (specifier.startsWith("@/")) base = specifier.slice(2);
    else if (specifier.startsWith(".")) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    } else return null; // A bare specifier is a package, and no card lives in one.
    for (const suffix of RESOLUTIONS) {
      if (files.has(base + suffix)) return base + suffix;
    }
    return files.has(base) ? base : null;
  };
}

/**
 * Does this import/export declaration load the module at run time?
 *
 * `import type`/`export type` erase, and so does a named list whose every specifier carries its own
 * `type` keyword. A bare `import "./x"` has no clause at all and always loads.
 */
function isValueEdge(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true; // A side-effect import always loads the module.
    if (clause.isTypeOnly) return false;
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named) && !clause.name) {
      return named.elements.some((element) => !element.isTypeOnly);
    }
    return true;
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.some((element) => !element.isTypeOnly);
  }
  return true; // `export * from "./x"` re-exports values too.
}

/** Literal static imports, re-exports and `import()` calls — the edges a bundler would follow. */
function importsOf(file: string, resolve: (s: string, f: string) => string | null): string[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edges = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isValueEdge(node)) {
      const target = resolve(node.moduleSpecifier.text, file);
      if (target) edges.add(target);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) {
        const target = resolve(first.text, file);
        if (target) edges.add(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...edges];
}

function buildGraph() {
  const files = sourceFiles();
  const set = new Set(files);
  const resolve = resolver(set);
  const edges = new Map(files.map((file) => [file, importsOf(file, resolve)]));
  const roots = files.filter(isRouteEntry);
  const reachable = new Set(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    for (const next of edges.get(stack.pop() as string) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      stack.push(next);
    }
  }
  return { files, set, roots, reachable, candidates: files.filter((f) => CANDIDATE.test(f)) };
}

// ------------------------------------------------------------------ titled assertions

/** `it`, `it.each`, `describe.only` … — the dotted name a call is made through, or null. */
function headChain(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const base = headChain(expression.expression);
    return base === null ? null : `${base}.${expression.name.text}`;
  }
  return null;
}

function collectStrings(node: ts.Node, out: string[]): void {
  if (ts.isStringLiteralLike(node)) out.push(node.text);
  else if (node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail) out.push((node as ts.LiteralLikeNode).text);
  ts.forEachChild(node, (child) => collectStrings(child, out));
}

/**
 * Every string a reader sees in this spec's run output: the title of each `it`/`test`/`describe`,
 * and — for an `.each` run — the case table that fills its `%s` placeholders. Nothing else counts;
 * a string buried in a fixture is not an assertion anybody named.
 */
function titlesOf(spec: string): string[] {
  const text = readFileSync(path.join(ROOT, spec), "utf8");
  const source = ts.createSourceFile(spec, text, ts.ScriptTarget.Latest, true,
    spec.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const chain = headChain(node.expression);
      if (chain !== null && TITLE_CALLEES.has(chain.split(".")[0])) {
        // `it.each([...])` carries the cases; a plain `it("…")` carries the title.
        if (chain.endsWith(".each")) for (const arg of node.arguments) collectStrings(arg, out);
        else if (node.arguments[0]) collectStrings(node.arguments[0], out);
      } else if (ts.isCallExpression(node.expression)) {
        // `it.each([...])("the %s title", fn)` — the outer call holds the title.
        const inner = headChain(node.expression.expression);
        if (inner !== null && TITLE_CALLEES.has(inner.split(".")[0]) && inner.endsWith(".each")
          && node.arguments[0]) collectStrings(node.arguments[0], out);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const titleCache = new Map<string, string[]>();
function titles(spec: string): string[] {
  const cached = titleCache.get(spec);
  if (cached !== undefined) return cached;
  const found = titlesOf(spec);
  titleCache.set(spec, found);
  return found;
}

/** Whole words, so "held" never passes on "withheld" and "error" never passes on "mirrored". */
function namesState(spec: string, state: string): boolean {
  const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i");
  return titles(spec).some((title) => pattern.test(title.replace(/\s+/g, " ")));
}

const started = Date.now();
const graph = buildGraph();
const elapsedMs = Date.now() - started;

const manifestPaths = new Set(CARD_MANIFEST.map((entry) => entry.path));

describe("the card import graph", () => {
  it("starts from every route file and reaches the app's own modules", () => {
    expect(graph.roots.length).toBeGreaterThan(0);
    expect(graph.roots.every(isRouteEntry)).toBe(true);
    // Every root is a file Next.js mounts; a screen module under `app/` is not one of them.
    expect(graph.roots).not.toContain("app/coach/CoachScreen.tsx");
    expect(graph.reachable.size).toBeGreaterThan(graph.roots.length);
    // A sanity anchor: Today's own card is reached through `app/page.tsx`, not assumed.
    expect(graph.reachable.has("components/SlotCard.tsx")).toBe(true);
    // And the screen `app/coach/page.tsx` imports is still reached, one edge further in.
    expect(graph.reachable.has("app/coach/CoachScreen.tsx")).toBe(true);
  });

  it("builds offline and inside the five-second budget", () => {
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it("finds the candidate cards the pattern names", () => {
    expect(graph.candidates.length).toBeGreaterThan(20);
  });

  it.each(graph.candidates)("%s is reachable from a route", (candidate) => {
    expect(graph.reachable.has(candidate)).toBe(true);
  });

  /*
   * Cards deleted this run (design §8.1), plus T1's moved grid. They must stay deleted, not come
   * back unmounted. The list is written inline rather than held in a const, because the gate reads
   * an `.each` case table out of the CALL — a named const would leave these names out of the run
   * output, and the self-test below is what proves that.
   */
  it.each([
    "components/EstimatorCard.tsx",
    "components/BodyDataCard.tsx",
    "components/ScaleWarning.tsx",
    "components/WeekGrid.tsx",
  ])("%s is absent, not merely unmounted", (deleted) => {
    expect(graph.set.has(deleted)).toBe(false);
  });
});

describe("a type-only edge is not a mount", () => {
  it("reads `import type` and a fully type-only list as no edge at all", () => {
    const parse = (text: string): boolean => {
      const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
      const [statement] = source.statements;
      return isValueEdge(statement as ts.ImportDeclaration | ts.ExportDeclaration);
    };
    expect(parse('import type { A } from "./a";')).toBe(false);
    expect(parse('import { type A, type B } from "./a";')).toBe(false);
    expect(parse('export type { A } from "./a";')).toBe(false);
    expect(parse('export { type A } from "./a";')).toBe(false);
  });

  it("keeps every edge that survives to run time", () => {
    const parse = (text: string): boolean => {
      const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
      const [statement] = source.statements;
      return isValueEdge(statement as ts.ImportDeclaration | ts.ExportDeclaration);
    };
    expect(parse('import "./a";')).toBe(true);
    expect(parse('import A from "./a";')).toBe(true);
    expect(parse('import A, { type B } from "./a";')).toBe(true);
    expect(parse('import { type A, b } from "./a";')).toBe(true);
    expect(parse('export * from "./a";')).toBe(true);
    expect(parse('export { a } from "./a";')).toBe(true);
  });
});

describe("a titled assertion, not a mention", () => {
  it("reads the title of a plain run and the cases of an `.each` run", () => {
    const found = titles("tests/cards/inventory.test.ts");
    expect(found).toContain("%s is reachable from a route");
    expect(found).toContain("components/EstimatorCard.tsx");
  });

  it("matches whole words only", () => {
    expect(namesState("tests/cards/inventory.test.ts", "reachable")).toBe(true);
    expect(namesState("tests/cards/inventory.test.ts", "achabl")).toBe(false);
  });
});

describe("the card manifest", () => {
  it.each(graph.candidates)("%s has a manifest entry", (candidate) => {
    expect(manifestPaths.has(candidate)).toBe(true);
  });

  it("has no glob wildcard and no orphan allowlist", () => {
    const text = readFileSync(path.join(__dirname, "manifest.ts"), "utf8");
    // A glob inside a quoted path is how an allowlist smuggles a whole directory past the gate.
    for (const literal of text.match(/"[^"\n]*"/g) ?? []) {
      expect(literal).not.toContain("*");
    }
    expect(CARD_MANIFEST.some((entry) => entry.path.includes("*"))).toBe(false);
    // Every entry carries exactly the four fields, so no escape hatch can be added quietly.
    for (const entry of CARD_MANIFEST) {
      expect(Object.keys(entry).sort()).toEqual(["card", "path", "renderTest", "states"]);
    }
  });

  it("names each card once", () => {
    const keys = CARD_MANIFEST.map((entry) => `${entry.path}#${entry.card}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(CARD_MANIFEST.map((entry): [string, CardManifestEntry] => [entry.path, entry]))(
    "%s is in the tree, reachable, and names its states and spec", (_path, entry) => {
      expect(graph.set.has(entry.path)).toBe(true);
      expect(graph.reachable.has(entry.path)).toBe(true);
      expect(entry.card.trim().length).toBeGreaterThan(0);
      expect(entry.states.length).toBeGreaterThan(0);
      for (const state of entry.states) expect(state.trim().length).toBeGreaterThan(0);
      expect(new Set(entry.states).size).toBe(entry.states.length);
      expect(entry.renderTest).toMatch(/\.test\.tsx?$/);
    });

  it.each(CARD_MANIFEST.flatMap((entry) => entry.states.map(
    (state): [string, string, string] => [entry.card, state, entry.renderTest])))(
    "%s's %s state is asserted under a title in %s", (_card, state, spec) => {
      expect(namesState(spec, state)).toBe(true);
    });
});
