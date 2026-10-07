import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Phase 9 §0.4: every storage key in client code is account-scoped (`smc:u:<id>:…` through
 * lib/device/account-storage.ts) or on the device-level allow-list below.
 */
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;
const ALLOWED = [
  // device-level
  "smc:body_capability", "meal-companion:install-prompt-dismissed", "smc:device:",
  "smc:coach:return",
  // account-scoped by construction
  "smc:u:", "smc:legacy:", "smc-u-",
  // already per account by user id in the key or the value
  "meal-companion:onboarding-disposition:", "smc:coach:current:", "meal-companion:food-pref-refs",
  // window event names, not storage
  "meal-companion:synced", "meal-companion:outbox-queued", "meal-companion:targets-changed",
  "meal-companion:log-queued", "meal-companion:body-profile-changed", "smc:session-check",
  // a BroadcastChannel name and a Web Lock name (reload boundary), not storage
  "smc:device", "smc:writer:",
];
const LITERAL = /["'`]((?:smc|meal-companion)[:-][A-Za-z0-9_:.-]*)/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function clientFiles(): string[] {
  return ["lib", "components", "app"].flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f));
}

describe("every storage key is account-scoped or device-level", () => {
  it("has no unscoped smc:/meal-companion: literal in client code", () => {
    const offenders: string[] = [];
    for (const file of clientFiles()) {
      // reads the old keys once, by design (spec §0.6)
      if (file === "lib/device/legacy-adoption.ts") continue;
      for (const m of stripComments(readFileSync(file, "utf8")).matchAll(LITERAL)) {
        const lit = m[1];
        if (!ALLOWED.some((a) => lit === a || lit.startsWith(a))) offenders.push(`${file}: ${lit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
