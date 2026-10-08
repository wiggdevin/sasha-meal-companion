import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Class combinations known to fail WCAG contrast (DESIGN.md §Contrast; the numbers are in
 * tests/design/contrast-table.ts). The scan reads every component's className expressions — string
 * literals, template parts, both arms of a conditional (each condition taken once per element, so
 * `on ? "a" : "b"` twice is never mixed), same-file constants and constants imported from a local
 * module — and checks each element against its JSX ancestors in the same file.
 *
 *   1. `olive-panel` with `text-on-olive*` on the element or a descendant (the protein card bug).
 *   2. `text-on-olive` / `text-on-olive-muted` anywhere: cream is for the olive fill (use
 *      `text-on-primary`) and the matte (where `text-charcoal` already turns cream).
 *   3. `text-on-primary` / `text-on-selected` on an element that also paints a light surface.
 *   4. `text-on-primary` / `text-on-selected` in a file that never paints the olive (or another dark)
 *      fill it needs.
 *   5. A gauge hue or rim colour as text (`text-gauge-*`, `text-yellow`, `text-orange`, `text-sage`,
 *      `text-tertiary` …), or a bare `.macro-*` gauge class on an element that is not a fill.
 *   6. A light surface (`well`, `bg-fog`, an arbitrary `bg-[var(--color-fog)]` …) inside a `.matte`
 *      scope with no `.matte-reset` between them. `.matte` turns the text roles cream but leaves
 *      `--color-fog` light, so the label reads cream on cream (onboarding v2 live QA, 2026-10-07:
 *      every chip in the facts beat). The `.matte` ancestor is followed ACROSS files: a component
 *      rendered inside a `.matte` element in another file (and every component it renders in turn)
 *      is scanned as matte-scoped.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const SOURCE_ROOTS = ["app", "components"];

const ON_OLIVE = /^text-on-olive(-muted)?(\/.*)?$/;
const ON_FILL = /^text-on-(primary|selected)(\/.*)?$/;
const LIGHT_SURFACE = /^(well|surface|olive-panel|pill-in|sheet-surface|attached-sheet|logged-card-in|meal-card-in|chip-off|chip-idle|btn-ink|notice|bg-(fog|field|surface|paper|secondary|background|neutral|white|[a-z]+-wash)(\/.*)?|bg-\[var\(--color-(fog|field|surface|paper|ivory|beige|oat|cream)[a-z-]*\)\](\/.*)?)$/;
/** Light surfaces that are a real problem under `.matte` (rule 6). `olive-panel` is excluded: it is
 *  a translucent tint that reads correctly on the matte (contrast-table.ts ".olive-panel in .matte"). */
const MATTE_LIGHT_SURFACE = /^(well|surface|pill-in|sheet-surface|chip-off|chip-idle|bg-(fog|field|surface|paper|background|white)(\/.*)?|bg-\[var\(--color-(fog|field|surface|paper|ivory|beige|oat|cream)[a-z-]*\)\](\/.*)?)$/;
/** A class or recipe that paints a fill `text-on-primary` can sit on. */
const FILL_MARKER = /(\bbg-(primary|selected|alert|red|red-ink|charcoal|well-dark|olive-[a-z-]+|sage-ink)\b|\bbtn-primary\b|\bbtn-icon\b|\bchip-on\b|\bday-lens\b|\bsegment-lens\b|\btab-pill\b|--grad-(ink|fab|produce)\b|--color-(primary|selected|alert)\b)/;
const GAUGE_TEXT = /^text-(gauge-[a-z-]+|yellow|orange|orange-warm|sage|green|sky|tangerine|signal|tertiary|clay)(\/.*)?$/;
const BARE_MACRO = /^macro-(kcal|protein|carbs|fat)$/;
const FILL_USE = /^(bg-current|fill-current|stroke-current|border-current)$/;

/** `path` → why its offending combination is genuinely fine. Stale entries fail. */
const ALLOWED: Record<string, string> = {};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function moduleFile(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(ROOT, specifier.slice(2))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  return [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find(existsSync) ?? null;
}

/** Every variable initialiser in a file, by name (the scan follows `${NAME}` and `className={NAME}`). */
function constants(source: ts.SourceFile): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  (function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      found.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  })(source);
  return found;
}

type Scope = {
  source: ts.SourceFile; consts: Map<string, ts.Expression>; imports: Map<string, string>;
  /** Every imported binding (default or named) a JSX tag can name → its local source file. */
  components: Map<string, string>;
};

function scopeOf(path: string): Scope {
  const source = parse(path);
  const imports = new Map<string, string>();
  const components = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const file = moduleFile(path, statement.moduleSpecifier.text);
    const named = statement.importClause?.namedBindings;
    if (file && named && ts.isNamedImports(named)) {
      for (const element of named.elements) { imports.set(element.name.text, file); components.set(element.name.text, file); }
    }
    const fallback = statement.importClause?.name;
    if (file && fallback) components.set(fallback.text, file);
  }
  return { source, consts: constants(source), imports, components };
}

const scopes = new Map<string, Scope>();
const scope = (path: string) => scopes.get(path) ?? scopes.set(path, scopeOf(path)).get(path)!;

/**
 * Every class set an expression can produce. Conditions are keyed by their source text, so the same
 * condition takes the same arm everywhere in one element.
 */
function classSets(expression: ts.Expression, from: Scope, depth = 0): string[][] {
  const conditions: string[] = [];
  const collect = (node: ts.Expression, at: Scope, level: number) => {
    walk(node, at, level, (text) => { if (!conditions.includes(text)) conditions.push(text); }, null);
  };
  collect(expression, from, depth);
  const limited = conditions.slice(0, 8);
  const results: string[][] = [];
  for (let mask = 0; mask < 2 ** limited.length; mask++) {
    const choice = new Map(limited.map((text, i) => [text, Boolean(mask & (1 << i))]));
    const tokens: string[] = [];
    walk(expression, from, depth, () => {}, { choice, out: tokens });
    results.push(tokens);
  }
  return results;
}

function walk(node: ts.Expression, at: Scope, depth: number, onCondition: (text: string) => void,
  emit: { choice: Map<string, boolean>; out: string[] } | null): void {
  if (depth > 6) return;
  const add = (text: string) => emit?.out.push(...text.split(/\s+/).filter(Boolean));
  const pick = (condition: ts.Expression) => {
    const text = condition.getText(at.source);
    onCondition(text);
    return emit?.choice.get(text) ?? false;
  };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { add(node.text); return; }
  if (ts.isTemplateExpression(node)) {
    add(node.head.text);
    for (const span of node.templateSpans) { walk(span.expression, at, depth + 1, onCondition, emit); add(span.literal.text); }
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)) { walk(node.expression, at, depth, onCondition, emit); return; }
  if (ts.isConditionalExpression(node)) {
    const arm = pick(node.condition);
    if (!emit) { walk(node.whenTrue, at, depth + 1, onCondition, emit); walk(node.whenFalse, at, depth + 1, onCondition, emit); return; }
    walk(arm ? node.whenTrue : node.whenFalse, at, depth + 1, onCondition, emit);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (pick(node.left) || !emit) walk(node.right, at, depth + 1, onCondition, emit);
      return;
    }
    walk(node.left, at, depth + 1, onCondition, emit);
    walk(node.right, at, depth + 1, onCondition, emit);
    return;
  }
  if (ts.isCallExpression(node)) { // cn(...), [..].join(" ")
    for (const argument of node.arguments) walk(argument, at, depth + 1, onCondition, emit);
    if (ts.isPropertyAccessExpression(node.expression)) walk(node.expression.expression, at, depth + 1, onCondition, emit);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) { for (const element of node.elements) walk(element as ts.Expression, at, depth + 1, onCondition, emit); return; }
  if (ts.isIdentifier(node)) {
    const local = at.consts.get(node.text);
    if (local) { walk(local, at, depth + 1, onCondition, emit); return; }
    const file = at.imports.get(node.text);
    if (file) {
      const other = scope(file);
      const exported = other.consts.get(node.text);
      if (exported) walk(exported, other, depth + 1, onCondition, emit);
    }
    return;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) { // styles.x, TONES.olive
    const target = at.consts.get(node.expression.text);
    if (target && ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(at.source) === node.name.text) {
          walk(property.initializer, at, depth + 1, onCondition, emit);
        }
      }
    }
  }
}

type Finding = { file: string; line: number; rule: string; classes: string };

function scanFile(path: string, matteFiles: ReadonlySet<string> = new Set()): Finding[] {
  const at = scope(path);
  const file = relative(ROOT, path);
  const text = at.source.getFullText();
  const hasFill = FILL_MARKER.test(text) || Array.from(at.imports.values()).some((dep) => FILL_MARKER.test(readFileSync(dep, "utf8")));
  const findings: Finding[] = [];
  const report = (node: ts.Node, rule: string, classes: string[]) => findings.push({
    file, line: at.source.getLineAndCharacterOfPosition(node.getStart()).line + 1, rule, classes: classes.join(" "),
  });

  function classesOf(element: ts.JsxOpeningLikeElement): string[][] {
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || attribute.name.getText(at.source) !== "className" || !attribute.initializer) continue;
      if (ts.isStringLiteral(attribute.initializer)) return [attribute.initializer.text.split(/\s+/)];
      if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
        return classSets(attribute.initializer.expression, at);
      }
    }
    return [[]];
  }

  /** A `style` that paints the olive fill itself (a pill whose active background is inline). */
  function styleFill(element: ts.JsxOpeningLikeElement): boolean {
    return element.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute)
      && attribute.name.getText(at.source) === "style" && FILL_MARKER.test(attribute.getText(at.source)));
  }

  function visit(node: ts.Node, panelAbove: boolean, matteAbove: boolean) {
    let panelHere = panelAbove;
    let matteHere = matteAbove;
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening) {
      const painted = styleFill(opening);
      const sets = classesOf(opening).map((set) => set.map((c) => c.split(":").at(-1)!.replace(/^!|!$/g, "")));
      if (sets.some((bare) => bare.includes("matte-reset"))) matteHere = false;
      else if (sets.some((bare) => bare.includes("matte"))) matteHere = true;
      for (const [index, bare] of sets.entries()) {
        // An element that IS the matte (the meal card's own root) paints the matte over its surface.
        if (matteAbove && !bare.includes("matte") && !bare.includes("matte-reset")
          && bare.some((c) => MATTE_LIGHT_SURFACE.test(c))) {
          report(opening, "light surface inside .matte without .matte-reset", classesOf(opening)[index]);
        }
      }
      for (const set of classesOf(opening)) {
        const bare = set.map((c) => c.split(":").at(-1)!.replace(/^!|!$/g, ""));
        const panel = bare.includes("olive-panel");
        const onOlive = bare.filter((c) => ON_OLIVE.test(c));
        if (onOlive.length && (panel || panelAbove)) report(opening, "olive-panel + text-on-olive", set);
        else if (onOlive.length) report(opening, "text-on-olive outside the olive fill", set);
        const onFill = bare.some((c) => ON_FILL.test(c));
        if (onFill && !painted && bare.some((c) => LIGHT_SURFACE.test(c))) report(opening, "text-on-primary on a light surface", set);
        if (onFill && !hasFill) report(opening, "text-on-primary with no primary fill in the file", set);
        if (bare.some((c) => GAUGE_TEXT.test(c))) report(opening, "gauge", set);
        if (bare.some((c) => BARE_MACRO.test(c)) && !bare.some((c) => FILL_USE.test(c))) report(opening, "gauge", set);
        panelHere ||= panel;
      }
    }
    ts.forEachChild(node, (child) => visit(child, panelHere, matteHere));
  }
  visit(at.source, false, matteFiles.has(path));
  return findings;
}

/** Follows a barrel's `export { X } from "./x"` to the file that defines `X`. */
function definingFile(file: string, name: string, depth = 0): string {
  if (depth > 4 || file.endsWith(".tsx")) return file;
  const source = parse(file);
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = moduleFile(file, statement.moduleSpecifier.text);
    if (!target) continue;
    const clause = statement.exportClause;
    if (!clause || (ts.isNamedExports(clause) && clause.elements.some((e) => e.name.text === name))) {
      const found = definingFile(target, name, depth + 1);
      if (found.endsWith(".tsx")) return found;
    }
  }
  return file;
}

/** The JSX tag of an element when it names an imported local component file. */
function tagFile(opening: ts.JsxOpeningLikeElement, at: Scope): string | null {
  if (!ts.isIdentifier(opening.tagName)) return null;
  const file = at.components.get(opening.tagName.text);
  return file ? definingFile(file, opening.tagName.text) : null;
}

/**
 * Rule 6's cross-file half: every source file rendered inside a `.matte` element somewhere (with no
 * `.matte-reset` between them), followed transitively — a matte-scoped component's own children
 * are matte-scoped too, unless it wraps them in `.matte-reset`.
 */
function matteScopedFiles(files: readonly string[]): Set<string> {
  const inside = new Set<string>();
  const renders = (path: string, startInMatte: boolean, found: (file: string) => void) => {
    const at = scope(path);
    const classSetsOf = (opening: ts.JsxOpeningLikeElement): string[][] => {
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(at.source) !== "className" || !attribute.initializer) continue;
        if (ts.isStringLiteral(attribute.initializer)) return [attribute.initializer.text.split(/\s+/)];
        if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) return classSets(attribute.initializer.expression, at);
      }
      return [[]];
    };
    const openingOf = (node: ts.Node) => ts.isJsxElement(node) ? node.openingElement
      : ts.isJsxSelfClosingElement(node) ? node : null;
    const flags = (opening: ts.JsxOpeningLikeElement) => {
      const sets = classSetsOf(opening).map((set) => set.map((c) => c.split(":").at(-1)!));
      return { reset: sets.some((bare) => bare.includes("matte-reset")), matte: sets.some((bare) => bare.includes("matte")) };
    };
    // A component whose root element is `.matte` renders its detached JSX (a `const content = <X/>`
    // later placed as `{content}`) inside that root too, so a root-level `.matte` makes every
    // detached JSX root in the file start matte-scoped.
    let rootMatte = startInMatte;
    (function findRoot(node: ts.Node, underJsx: boolean) {
      const opening = openingOf(node);
      if (opening && !underJsx) { const f = flags(opening); if (f.matte && !f.reset) rootMatte = true; }
      ts.forEachChild(node, (child) => findRoot(child, underJsx || opening !== null));
    })(at.source, false);
    (function visit(node: ts.Node, inMatte: boolean, underJsx: boolean) {
      const opening = openingOf(node);
      let here = opening && !underJsx ? rootMatte : inMatte;
      if (opening) {
        const f = flags(opening);
        if (f.reset) here = false;
        else if (f.matte) here = true;
        const file = tagFile(opening, at);
        if (here && file) found(file);
      }
      ts.forEachChild(node, (child) => visit(child, here, underJsx || opening !== null));
    })(at.source, startInMatte, false);
  };
  // Followed transitively only inside the feature folder that owns the `.matte` root (a shell and
  // its own parts, e.g. components/Onboarding/**). A root directly under app/ or components/ (the
  // dock, the meal card) is followed one hop, since its shared children (sheets that portal out,
  // toasts) render outside that scope at runtime.
  const queue: { file: string; root: string }[] = [];
  const owned = (file: string, root: string) => {
    const folder = dirname(root);
    const shallow = SOURCE_ROOTS.some((name) => folder === join(ROOT, name));
    return shallow ? dirname(file) === folder : file.startsWith(`${folder}/`);
  };
  const add = (root: string) => (file: string) => {
    if (inside.has(file) || !/\.tsx$/.test(file)) return;
    inside.add(file);
    if (owned(file, root)) queue.push({ file, root });
  };
  for (const file of files) renders(file, false, add(file));
  while (queue.length) { const next = queue.shift()!; renders(next.file, true, add(next.root)); }
  return inside;
}

function scanAll(): Finding[] {
  const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)));
  const matteFiles = matteScopedFiles(files);
  return files.flatMap((file) => scanFile(file, matteFiles));
}

describe("contrast scan", () => {
  const findings = scanAll();
  const key = (f: Finding) => `${f.file}:${f.rule}`;

  it("finds no class combination known to fail contrast", () => {
    const unexpected = findings.filter((f) => !ALLOWED[key(f)])
      .map((f) => `${f.file}:${f.line} ${f.rule} — ${f.classes}`);
    expect([...new Set(unexpected)]).toEqual([]);
  });

  it("every allowlisted file still needs its entry", () => {
    const used = new Set(findings.map(key));
    expect(Object.keys(ALLOWED).filter((entry) => !used.has(entry))).toEqual([]);
  });

  it("catches the protein card bug and its cousins in a fixture", () => {
    const fixture = join(ROOT, "tests/design/fixtures/contrast-offenders.tsx");
    const rules = scanFile(fixture).map((f) => f.rule);
    expect(rules).toContain("olive-panel + text-on-olive");
    expect(rules).toContain("text-on-olive outside the olive fill");
    expect(rules).toContain("text-on-primary on a light surface");
    expect(rules).toContain("text-on-primary with no primary fill in the file");
    expect(rules.filter((rule) => rule === "gauge")).toHaveLength(2);
  });

  it("catches a light chip inside a .matte ancestor in ANOTHER file, including the arbitrary"
    + " bg-[var(--color-fog)] fill (onboarding v2 live QA: cream text on fog chips)", () => {
    const shell = join(ROOT, "tests/design/fixtures/matte-shell.tsx");
    const chip = join(ROOT, "tests/design/fixtures/matte-chip.tsx");
    const matteFiles = matteScopedFiles([shell]);
    expect(matteFiles.has(chip)).toBe(true);
    const rules = scanFile(chip, matteFiles).map((f) => f.rule);
    expect(rules.filter((rule) => rule === "light surface inside .matte without .matte-reset")).toHaveLength(2);
    // The same chip outside any .matte scope is fine, and a .matte-reset wrapper clears it.
    expect(scanFile(chip).map((f) => f.rule)).not.toContain("light surface inside .matte without .matte-reset");
  });
});
