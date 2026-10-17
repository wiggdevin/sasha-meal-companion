/**
 * T9 §3 guard: `docs/features.md` must not rot again.
 *
 *   pnpm lint:docs            # docs/features.md, then docs/architecture.md
 *   tsx scripts/check-features.ts <file>   # any copy of features.md, which is how the test seeds a lie
 *   tsx scripts/check-features.ts --architecture <file>   # any copy of architecture.md
 *
 * One rule, in two directions, over every cell of the row — Detail and Acceptance name files as
 * often as Source does. A `planned` row may not name, in backticks, a file that exists (the
 * feature shipped and nobody said so), and an `exists` row may not name one that does not (the
 * file moved and nobody said so). Nothing cleverer — a checker that tried to judge whether a
 * feature "really" runs would need the whole codebase's meaning, and would be wrong quietly.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ARCHITECTURE = "docs/architecture.md";
const args = process.argv.slice(2);
const architectureOnly = args[0] === "--architecture";
const FEATURES = architectureOnly ? "" : (args[0] ?? "docs/features.md");
/**
 * A backticked token with one of the repo's file extensions: `lib/server/log.ts`,
 * `scripts/import-fdc.py`, `app/globals.css`. Only backticked text is read, and only these
 * extensions — a backticked `lib` or `set_constraints` carries no claim and is ignored on
 * purpose, because guessing whether a bare word is a path is how a linter starts lying.
 *
 * A leading `@/` is the tsconfig alias for the repo root (tsconfig.json `paths`), so a row is
 * free to write a path the way the code imports it.
 */
const PATH_IN_BACKTICKS =
  /`(@\/)?([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|py|sh|css|svg|json|md|yml|yaml))`/g;

type Row = { line: number; id: string; disposition: string; paths: string[] };

/** Every cell but the ID, the phase and the disposition itself. */
function notesOf(cells: string[]): string {
  return [cells[2], cells[3], cells[6], cells[7]].join(" ");
}

function rows(markdown: string): Row[] {
  const out: Row[] = [];
  markdown.split("\n").forEach((line, i) => {
    if (!line.startsWith("| F-")) return;
    const cells = line.split("|").map((c) => c.trim());
    // | ID | Feature | Detail | Phase | Disposition | Source | Acceptance |
    if (cells.length < 8) return;
    out.push({
      line: i + 1, id: cells[1], disposition: cells[5].toLowerCase(),
      paths: [...notesOf(cells).matchAll(PATH_IN_BACKTICKS)].map((m) => m[2]),
    });
  });
  return out;
}

function problems(all: Row[], root: string): string[] {
  const found: string[] = [];
  for (const row of all) {
    for (const file of row.paths) {
      const there = existsSync(path.join(root, file));
      if (row.disposition === "planned" && there) {
        found.push(`${FEATURES}:${row.line} ${row.id} reads "planned" but \`${file}\` exists.`);
      }
      if (row.disposition === "exists" && !there) {
        found.push(`${FEATURES}:${row.line} ${row.id} reads "exists" but \`${file}\` does not.`);
      }
    }
  }
  return found;
}

const root = process.cwd();

/**
 * architecture.md has no disposition column, so its one rule is the "exists" half: a backticked
 * file path it names must be there. A path that was removed is written without backticks.
 */
function architectureProblems(file: string): string[] {
  const found: string[] = [];
  readFileSync(path.resolve(root, file), "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PATH_IN_BACKTICKS)) {
      if (!existsSync(path.join(root, m[2]))) {
        found.push(`${file}:${i + 1} names \`${m[2]}\` but it does not exist.`);
      }
    }
  });
  return found;
}

let found: string[] = [];
let checked = "";
if (!architectureOnly) {
  const all = rows(readFileSync(path.resolve(root, FEATURES), "utf8"));
  if (all.length === 0) {
    console.error(`${FEATURES}: no feature rows found — has the table shape changed?`);
    process.exit(1);
  }
  found = problems(all, root);
  checked = `${FEATURES}: ${all.length} rows`;
}
if (architectureOnly || args.length === 0) {
  const file = architectureOnly ? (args[1] ?? ARCHITECTURE) : ARCHITECTURE;
  found = found.concat(architectureProblems(file));
  checked = `${checked ? `${checked}; ` : ""}${file} paths`;
}
for (const problem of found) console.error(problem);
console.error(`${checked}, ${found.length} problem(s).`);
process.exit(found.length === 0 ? 0 : 1);
