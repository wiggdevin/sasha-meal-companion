// predev: refresh origin/main so the dev banner (lib/dev/freshness.ts) compares against the real
// main. Offline or slow is fine: it gives up after 8 s and never blocks `next dev`.
import { spawnSync } from "node:child_process";
const run = spawnSync("git", ["fetch", "--quiet", "origin", "main"], { timeout: 8_000, stdio: "ignore" });
if (run.status !== 0) console.warn("dev-fetch: could not refresh origin/main; the old-code banner may be stale.");
