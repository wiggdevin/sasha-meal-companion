import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The test files the Integration job runs against a local database (2026-10-04). The unit
 * shards already run every file without one, and a file that passes there cannot assert
 * anything that needs a database, unless it skips without one or reads the database settings.
 * So a file under tests/ is selected when it has a skip construct, or when it or a test helper
 * it imports (followed through tests/ only) names the SUPABASE_TEST_* settings. App code is
 * not followed: lib/server/admin.ts names them too, and every server test would match.
 * Before this, Integration ran all 800 files under tests/ again, 88 of which use a database.
 */
const SKIP = /\b(?:skipIf|runIf)\(|\.skip\b|\bskip\(/;
const DB_SETTINGS = /SUPABASE_TEST_/;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

export function integrationTestFiles(root: string): string[] {
  const testsDir = path.join(root, "tests");
  const sources = new Map<string, string>();
  const read = (file: string): string => {
    const cached = sources.get(file);
    if (cached !== undefined) return cached;
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    return source;
  };

  function resolve(spec: string, from: string): string | null {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2))
      : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of EXTENSIONS) {
      const file = base + ext;
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
  }

  // No result cache: a "no" reached by cutting an import cycle is not a final answer.
  function namesDbSettings(file: string, seen: Set<string>): boolean {
    if (seen.has(file)) return false;
    seen.add(file);
    const source = read(file);
    if (DB_SETTINGS.test(source)) return true;
    for (const match of source.matchAll(IMPORT)) {
      const target = resolve(match[1], file);
      if (target?.startsWith(testsDir + path.sep) && namesDbSettings(target, seen)) return true;
    }
    return false;
  }

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  return walk(testsDir)
    .filter((file) => SKIP.test(read(file)) || namesDbSettings(file, new Set()))
    .map((file) => path.relative(root, file))
    .sort();
}
