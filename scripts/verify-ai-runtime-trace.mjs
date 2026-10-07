import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "noop.js"));
let packageDir = path.dirname(require.resolve("@google/genai"));
let manifest = null;
for (let depth = 0; depth < 8 && manifest === null; depth += 1) {
  try {
    const candidate = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (candidate.name === "@google/genai") manifest = candidate;
  } catch { /* keep walking toward the package root */ }
  packageDir = path.dirname(packageDir);
}
if (!manifest) throw new Error("Build cannot locate the installed @google/genai manifest");
const pinned = JSON.parse(readFileSync("lib/ai/sdk-version.json", "utf8"));
if (manifest.version !== pinned.version || Number(manifest.version.split(".")[0]) !== pinned.major) {
  console.error("AI SDK version pin does not match the installed package", {
    pinnedVersion: pinned.version,
    pinnedMajor: pinned.major,
    installedVersion: manifest.version,
  });
  process.exit(1);
}

const tracePath = ".next/server/app/api/coach/route.js.nft.json";
const trace = JSON.parse(readFileSync(tracePath, "utf8"));
const files = Array.isArray(trace.files) ? trace.files : [];
const normal = files.map((file) => String(file).replaceAll("\\", "/"));
const hasExternalSdk = normal.some((file) => file.includes("@google/genai"));

if (hasExternalSdk) {
  console.error("AI runtime trace externalizes @google/genai; Vercel cannot resolve it from /var/task");
  process.exit(1);
}

console.log(`AI runtime: bundled Google SDK ${pinned.version}; build-time version pin matched`);
