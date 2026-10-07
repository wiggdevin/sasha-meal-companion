/**
 * Downloads the W1b inputs (sources.ts) and the W4 Foundation list (input-sources.ts) into the
 * offline workspace (workspace.ts). Existing files are kept unless --force. Run once before
 * `build.ts` or `scripts/import-fndds-inputs.ts`:
 *
 *   pnpm exec tsx scripts/priors/fetch.ts [--force]
 *
 * Public files from the official CDC and USDA sites only. Nothing here touches the repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FOUNDATION_SOURCE } from "@/scripts/priors/input-sources";
import { SOURCES } from "@/scripts/priors/sources";
import { resolveWorkspace } from "@/scripts/priors/workspace";

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const workspace = resolveWorkspace(process.cwd());
  for (const source of [...SOURCES, FOUNDATION_SOURCE]) {
    const missing = source.files.filter((file) => force || !existsSync(join(workspace, file)));
    if (!missing.length) { console.log(`${source.id}: present`); continue; }
    if (source.kind === "nhanes") {
      for (const file of missing) await download(`${source.url}${basename(file)}`, join(workspace, file));
    } else {
      const zip = join(workspace, "downloads", basename(source.url));
      await download(source.url, zip);
      const into = join(workspace, dirname(source.files[0]));
      mkdirSync(into, { recursive: true });
      execFileSync("unzip", ["-o", "-j", "-q", zip, "*.csv", "-d", into]);
    }
    console.log(`${source.id}: fetched`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
