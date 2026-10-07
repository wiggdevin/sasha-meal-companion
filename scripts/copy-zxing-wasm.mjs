#!/usr/bin/env node
/**
 * Copies the zxing-wasm reader's *.wasm files into public/zxing/ so the browser can
 * fetch them from our own origin instead of a CDN (contracts §0.1). Runs as
 * `postinstall`; CI installs with --frozen-lockfile so the package is always present,
 * but a missing package (e.g. a partial local install) exits 0 rather than failing
 * the whole `pnpm install`.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "node_modules", "zxing-wasm", "dist", "reader");
const destDir = join(repoRoot, "public", "zxing");

if (!existsSync(sourceDir)) {
  console.log("copy-zxing-wasm: zxing-wasm not installed, skipping");
  process.exit(0);
}

const wasmFiles = readdirSync(sourceDir).filter((name) => name.endsWith(".wasm"));

if (wasmFiles.length === 0) {
  console.log("copy-zxing-wasm: no .wasm files found under dist/reader, skipping");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

for (const name of wasmFiles) {
  copyFileSync(join(sourceDir, name), join(destDir, name));
}

console.log(`copy-zxing-wasm: copied ${wasmFiles.length} file(s) to public/zxing/`);
