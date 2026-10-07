/**
 * Audit finding T2/P1. The bug was a parameter alias (`env.NEXT_PUBLIC_CAPTURE_METHODS`), which
 * Next.js cannot inline into the browser bundle; the fix is a literal read in
 * `lib/capture/public-flags.ts`. A Node test cannot observe the inlining itself, so this covers
 * the two things that can be wrong in source: the literals sit where the bundler needs them, and
 * the helper parses exactly what `enabledMethods` parses, so the halves cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enabledMethods } from "@/lib/capture/flags";
import { publicCaptureMethods, publicFeatureScan } from "@/lib/capture/public-flags";

const FLAG_KEYS = ["NEXT_PUBLIC_CAPTURE_METHODS", "NEXT_PUBLIC_FEATURE_SCAN"] as const;

let saved: Partial<Record<(typeof FLAG_KEYS)[number], string>> = {};

beforeEach(() => {
  saved = {};
  for (const key of FLAG_KEYS) {
    if (process.env[key] !== undefined) saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of FLAG_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the browser-visible capture methods", () => {
  it("is read where Next.js can inline it: the literal in one file, never a parameter alias elsewhere", () => {
    // The bug being fixed was `env.NEXT_PUBLIC_CAPTURE_METHODS`, which Next.js does not inline
    // (docs/app/guides/environment-variables: only literal member accesses are replaced). A Node
    // run cannot see that inlining, so this locks the shape the bundler needs: one home for the
    // literal, and no capture module reading the flag off an `env` record.
    const reader = readFileSync(path.join(__dirname, "public-flags.ts"), "utf8");
    expect(reader).toContain("process.env.NEXT_PUBLIC_CAPTURE_METHODS");
    for (const file of ["flags.ts", "../capture-client.ts", "../../components/CaptureRow.tsx"]) {
      expect(readFileSync(path.join(__dirname, file), "utf8")).not.toContain("process.env.NEXT_PUBLIC_");
    }
    // And the fallback is wired, not just present: dropping this call is the pre-fix state.
    expect(readFileSync(path.join(__dirname, "flags.ts"), "utf8")).toContain("publicCaptureMethods()");
  });

  it("parses exactly what enabledMethods parses: trim, case, unknown values, canonical order", () => {
    process.env.NEXT_PUBLIC_CAPTURE_METHODS = " Photo , text, barcode ";
    expect(publicCaptureMethods()).toBe(" Photo , text, barcode ");
    expect(enabledMethods(publicCaptureMethods())).toEqual(enabledMethods(" Photo , text, barcode "));
    expect(enabledMethods(publicCaptureMethods())).toEqual(["text", "photo"]);
  });

  it("leaves the flag unset when nothing sets it", () => {
    expect(publicCaptureMethods()).toBeUndefined();
    expect(enabledMethods(publicCaptureMethods())).toEqual([]);
  });
});

describe("the barcode flag", () => {
  it('is on only at the exact value "1"; any other string is off', () => {
    expect(publicFeatureScan()).toBe(false);
    process.env.NEXT_PUBLIC_FEATURE_SCAN = "1";
    expect(publicFeatureScan()).toBe(true);
    for (const other of ["0", "true", "yes", ""]) {
      process.env.NEXT_PUBLIC_FEATURE_SCAN = other;
      expect(publicFeatureScan()).toBe(false);
    }
  });
});
