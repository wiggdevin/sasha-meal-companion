/**
 * Phase 18 W2b (Sol r1 WARN 8): every trigger function a migration from W2b on creates is declared
 * in tests/tenancy/rpc-internal.json, so tests/tenancy/rpc-matrix.test.ts checks its grant and its
 * trigger. A static read of the migration files: it runs in every unit shard, with no database.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import internal from "./rpc-internal.json";

const DIR = path.join(process.cwd(), "supabase/migrations");
/** The first W2b migration; older files predate this check. */
const FROM = "20261213090000";
const TRIGGER_FUNCTION = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(\s*\)\s+returns\s+trigger/gi;

describe("trigger functions from W2b on are declared", () => {
  it("names every one in rpc-internal.json", () => {
    const found = readdirSync(DIR).filter((file) => file.endsWith(".sql") && file.split("_")[0] >= FROM)
      .flatMap((file) => [...readFileSync(path.join(DIR, file), "utf8").matchAll(TRIGGER_FUNCTION)]
        .map((match) => `${match[1].toLowerCase()}()`));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((signature) => !(signature in internal))).toEqual([]);
  });
});
