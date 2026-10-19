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
  // device-level: whether/when THIS DEVICE has been opened, declined an Android install prompt,
  // etc. — same precedent as install-prompt-dismissed above, never account data.
  "meal-companion:install-prompt-opens", "meal-companion:install-prompt-last-open-at",
  "meal-companion:install-prompt-android-declined-at",
  "meal-companion:install-prompt-android-declined-meals",
  // account-scoped by construction
  "smc:u:", "smc:legacy:", "smc-u-",
  // already per account by user id in the key or the value
  "meal-companion:onboarding-disposition:", "smc:coach:current:", "meal-companion:food-pref-refs",
  // window event names, not storage
  "meal-companion:synced", "meal-companion:outbox-queued", "meal-companion:targets-changed",
  "meal-companion:log-queued", "meal-companion:body-profile-changed", "smc:session-check",
  "meal-companion:android-install-ready", "meal-companion:android-installed",
  "meal-companion:install-prompt-opens-changed",
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

/**
 * W056 (B159): every client file that touches browser storage, and how its keys are scoped. A new
 * file fails this test until it is listed here; the runtime proof is two-account-storage.test.tsx
 * and the result is docs/readiness/2026-10-11/w056-device-storage.md.
 */
const STORAGE_FILES: Record<string, string> = {
  "lib/store.ts": "account: smc:u:<id>:store",
  "lib/coach-client.ts": "account: smc:u:<id>:coach:<thread> (memory fallback when storage is blocked)",
  "lib/barcode/scan-cache.ts": "account: smc:u:<id>:pending_scans",
  "lib/capture/drafts.ts": "account: smc:u:<id>:draft:<id>",
  "lib/coach/apply-client.ts": "account: smc:u:<id>:coach-action:*",
  "lib/coach/undo-client.ts": "account: smc:u:<id>:coach-undo:*",
  "lib/device/account-storage.ts": "account: the smc:u:<id>: helpers",
  "lib/device/boot.ts": "IndexedDB presence check before legacy adoption; no key",
  "lib/device/forget.ts": "device: smc:device:accounts registry (ids only); reads smc-u-<id>",
  "lib/device/erase.ts": "account, after deletion: removes smc:u:<id>:*, keys naming <id>, its registry entry and IndexedDB smc-u-<id>",
  "lib/device/legacy-recovery.ts": "device: smc:device:legacy-recovered:<op id> → owner id (W055 owner-run recovery; reads the legacy smc database, never writes it)",
  "lib/device/legacy-adoption.ts": "legacy: moves old keys under smc:legacy:, holds the smc database",
  "lib/device/tab-signal.ts": "device: smc:device:signal",
  "lib/design/ground-boot.ts": "device: smc:device:ground (pre-paint read)",
  "lib/design/ground-pref.ts": "account: ground; device: smc:device:ground",
  "lib/device/writer-lock.ts": "device, per account id: smc:device:writer:<id>",
  "lib/foods/prefs-client.ts": "account by value: meal-companion:food-pref-refs { <id>: … }",
  "lib/foods/starter-seed.ts": "account: smc:u:<id>:starter-suggestions-seeded-v1",
  "lib/health/capability.ts": "device (session): smc:body_capability",
  "lib/profile/onboarding-state.ts": "account: smc:u:<id>:onboarding-invite-dismissed-at",
  "lib/recipes/session-checks.ts": "account (session): smc:u:<id>:recipe-checks:<revision>",
  "lib/sync/idb.ts": "account: IndexedDB smc-u-<id>",
  "components/AuthGate.tsx": "account id in key: meal-companion:onboarding-disposition:<id>",
  "components/DayNutrients.tsx": "account (session): smc:u:<id>:today-dismissed:*",
  "components/InstallPrompt.tsx": "device: meal-companion:install-prompt-*",
  "components/InstallPromptCapture.tsx": "device: meal-companion:install-prompt-opens*",
  "components/RecipeResults.tsx": "account id in key (session): recipe-expanded:<id>:<block>",
  "components/ShoppingRoot.tsx": "account id in key: shopping-location:<id>, shopping-stores:<id>",
  "components/shopping/build/StepStores.tsx": "account id in key: reads shopping-location:<id>; shopping-build-area:<id> (the typed store area, never sent as locale); shopping-picked-stores:<id> (store names, at most 5)",
  "components/coach/RoleConfirm.tsx": "account: smc:u:<id>:role-confirm:<action>",
  "components/coach/coach-resume.ts": "account id in key: smc:coach:current:<id>",
  "components/coach/taste-chips-storage.ts": "account: smc:u:<id>:taste-chips:<proposal>",
  "components/Onboarding/v2/draft-store.ts": "account by record key: IndexedDB onboarding-draft-v2, key <id>",
  "components/today/care/sound.ts": "device: care:sound-muted",
};
const STORAGE_USE = /\b(localStorage|sessionStorage|indexedDB)\b|\bopenDB\(/;

describe("every file that touches browser storage is inventoried", () => {
  it("lists exactly the client files that use localStorage, sessionStorage or IndexedDB", () => {
    const users = clientFiles().filter((f) => STORAGE_USE.test(stripComments(readFileSync(f, "utf8"))));
    expect(users.sort()).toEqual(Object.keys(STORAGE_FILES).sort());
  });
});
