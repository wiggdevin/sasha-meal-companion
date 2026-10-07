/**
 * Phase 18 W4 acceptance 1 (pure half): the FNDDS-inputs plan resolves every documented input
 * code, stores no fortificant, refuses an unresolved code or another FNDDS release, and a commit
 * converges (scripts/priors/fndds-inputs.ts, scripts/priors/fndds-inputs-rows.ts). The database
 * half is tests/migrations/catalog-food-inputs-db.test.ts; the real-data run is
 * docs/catalog/fndds-inputs-sizing.md.
 */
import { describe, expect, it } from "vitest";
import { planInputs, resolveCode, type CodeMaps } from "@/scripts/priors/fndds-inputs";
import { batchByDish, buildRows, diffRows, replaceBatches, type InputRow } from "@/scripts/priors/fndds-inputs-rows";
import { postWriteFindings, releaseFindings, type ReleaseEvidence } from "@/scripts/priors/fndds-release";
import { assertImportTarget, parseImportArgs } from "@/scripts/priors/import-guard";
import { FNDDS_RELEASE } from "@/scripts/priors/input-sources";
import { writeDishes, type ReplaceDishes } from "@/scripts/import-fndds-inputs";
import { licenceFindings } from "@/scripts/priors/sources";
import { INPUT_SOURCES } from "@/scripts/priors/input-sources";

const maps: CodeMaps = {
  fnddsByCode: new Map([["58106210", "2710010"], ["11111000", "2705385"]]),
  srByNdb: new Map([["1077", { fdcId: "171265", description: "Milk, whole, 3.25% milkfat, with added vitamin D" }],
    ["7028", { fdcId: "168000", description: "Ham, sliced, pre-packaged, deli meat (96%fat free, water added)" }],
    ["11540", { fdcId: "170500", description: "Tomato juice, canned, with salt added" }]]),
  foundationByNdb: new Map([["100260", "2346405"]]),
};

describe("resolveCode", () => {
  it("resolves an FNDDS sub-recipe, an SR number and a Foundation number", () => {
    expect(resolveCode("58106210", "Lasagna", maps)).toEqual({ kind: "fndds", source: "fdc_fndds", fdcId: "2710010" });
    expect(resolveCode("1077", "Milk", maps)).toEqual({ kind: "sr_legacy", source: "fdc_sr_legacy", fdcId: "171265" });
    expect(resolveCode("100260", "Spinach, baby", maps)).toEqual({ kind: "foundation", source: "fdc_foundation",
      fdcId: "2346405" });
  });

  it("resolves FNDDS's modified SR item to its SR base only when the base's description matches", () => {
    expect(resolveCode("907028", "REDUCED SODIUM: Ham, sliced, pre-packaged, deli meat (96%fat free, water added)", maps))
      .toEqual({ kind: "sr_modified", source: "fdc_sr_legacy", fdcId: "168000" });
    expect(resolveCode("911540", "LOW SODIUM: Tomato juice, canned", maps)).toMatchObject({ fdcId: "170500" });
    expect(resolveCode("907028", "REDUCED SODIUM: Bologna", maps)).toBeNull();
    expect(resolveCode("907028", "Ham, sliced", maps)).toBeNull();
  });

  it("names a nutrient added as an ingredient a fortificant, never a food", () => {
    expect(resolveCode("999328", "Vitamin D as ingredient", maps)).toEqual({ kind: "fortificant" });
    expect(resolveCode("999001", "Vitamin B composite in cereals", maps)).toEqual({ kind: "fortificant" });
    expect(resolveCode("999328", "Lard", maps)).toBeNull();
  });

  it("leaves anything else unresolved", () => {
    expect(resolveCode("99999999", "Mystery stew", maps)).toBeNull();
    expect(resolveCode("12345", "Unknown SR", maps)).toBeNull();
  });
});

const input = (fdc: string, seq: number, code: string, grams: number, description = "x") =>
  ({ id: `${fdc}-${seq}`, fdc_id: fdc, seq_num: String(seq), sr_code: code, sr_description: description,
    gram_weight: String(grams) });
const foods = [{ fdc_id: "2710010", food_code: "58106210" }, { fdc_id: "2705385", food_code: "11111000" },
  { fdc_id: "2705383", food_code: "11000000" }];

describe("planInputs", () => {
  const rows = [input("2710010", 2, "1077", 40), input("2710010", 1, "11111000", 60),
    input("2710010", 3, "999328", 0.001, "Vitamin D as ingredient"), input("2705385", 1, "1077", 100)];

  it("plans every dish that lists inputs, in seq order, with fortificants counted and not stored", () => {
    const plan = planInputs(rows, foods, maps);
    expect(plan.report).toMatchObject({ fnddsFoods: 3, dishesListingInputs: 2, dishesWithStoredInputs: 2,
      sourceRows: 4, storedRows: 3, fortificantRows: 1, fortificantCodes: ["999328"], unresolved: [],
      byKind: { fndds: 1, sr_legacy: 2, foundation: 0, sr_modified: 0 } });
    expect(plan.dishes.get("2710010")!.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("reports an unresolved code", () => {
    const plan = planInputs([...rows, input("2705385", 2, "424242", 5, "Mystery")], foods, maps);
    expect(plan.report.unresolved).toEqual([{ dishFdcId: "2705385", seq: 2, code: "424242", description: "Mystery" }]);
  });

  it("refuses a non-positive gram weight and a repeated seq", () => {
    expect(() => planInputs([input("2705385", 1, "1077", 0)], foods, maps)).toThrow(/out of range/);
    expect(() => planInputs([input("2705385", 1, "1077", 5), input("2705385", 1, "1077", 6)], foods, maps))
      .toThrow(/listed twice/);
  });
});

describe("buildRows and diffRows", () => {
  const plan = planInputs([input("2710010", 1, "11111000", 60), input("2710010", 2, "1077", 40)], foods, maps);
  const catalog = [{ id: 1, source: "fdc_fndds", source_id: "2710010" }, { id: 2, source: "fdc_fndds", source_id: "2705385" },
    { id: 3, source: "fdc_sr_legacy", source_id: "171265" }];
  const active = [{ id: 10, catalog_food_id: 1, catalog_version_id: 7 }];

  it("writes one row per input of the dish's active revision, source fndds, estimated", () => {
    const result = buildRows(plan, catalog, active, 7);
    expect(result.problems).toEqual([]);
    expect(result.rows).toEqual([
      { food_revision_id: 10, seq: 1, input_catalog_food_id: 2, grams: 60, source: "fndds", estimated: true },
      { food_revision_id: 10, seq: 2, input_catalog_food_id: 3, grams: 40, source: "fndds", estimated: true }]);
  });

  it("refuses a revision of another catalog version even when it reads the same, and a missing input food", () => {
    const other = buildRows(plan, catalog, [{ ...active[0], catalog_version_id: 8 }], 7);
    expect(other.rows).toEqual([]);
    expect(other.problems[0]).toMatch(/belongs to catalog version 8, not 7/);
    const missing = buildRows(plan, catalog.filter((food) => food.id !== 3), active, 7);
    expect(missing.rows).toEqual([]);
    expect(missing.problems[0]).toMatch(/not in the catalog/);
  });

  it("converges: unchanged rows are left, changed ones upserted, stale ones of planned revisions deleted", () => {
    const { rows, revisionIds } = buildRows(plan, catalog, active, 7);
    const stored = [{ ...rows[0] }, { ...rows[1], grams: 41 }, { ...rows[1], seq: 3 },
      { food_revision_id: 99, seq: 1, input_catalog_food_id: 3, grams: 1, source: "fndds", estimated: true }];
    const diff = diffRows(rows, stored, revisionIds);
    expect(diff).toEqual({ upserts: [rows[1]], deletes: [{ food_revision_id: 10, seq: 3 }], unchanged: 1 });
    expect(diffRows(rows, rows, revisionIds)).toEqual({ upserts: [], deletes: [], unchanged: 2 });
  });

  it("batches whole dishes only", () => {
    const row = (revision: number, seq: number): InputRow => ({ food_revision_id: revision, seq, input_catalog_food_id: 1,
      grams: 1, source: "fndds", estimated: true });
    const batches = batchByDish([row(1, 1), row(1, 2), row(2, 1), row(2, 2), row(3, 1)], 3);
    expect(batches.map((batch) => batch.map((r) => r.food_revision_id))).toEqual([[1, 1], [2, 2, 3]]);
  });
});

describe("licences and the write guard", () => {
  it("reads only allowlisted, commercially cleared sources", () => {
    expect(licenceFindings(INPUT_SOURCES, false)).toEqual([]);
    expect(INPUT_SOURCES.map((source) => source.licence)).toEqual(["cc0-1.0", "cc0-1.0", "cc0-1.0"]);
  });

  it("allows a dry run anywhere and a commit to a loopback stack", () => {
    const production = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(() => assertImportTarget(parseImportArgs([]), production)).not.toThrow();
    expect(() => assertImportTarget(parseImportArgs(["--dry-run"]), production)).not.toThrow();
    for (const url of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]) {
      expect(() => assertImportTarget(parseImportArgs(["--commit"]), url)).not.toThrow();
    }
  });

  it("refuses a commit to ANY non-local host without --production and a matching --project-ref", () => {
    const other = "https://abcdefghijklmnopqrst.supabase.co";
    const production = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(() => assertImportTarget(parseImportArgs(["--commit"]), other)).toThrow(/non-local host/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production"]), other)).toThrow(/--project-ref/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--project-ref", "abcdefghijklmnopqrst"]), other))
      .toThrow(/non-local host/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "fivatgdpuenszxxnijpc"]),
      other)).toThrow(/does not match/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "abcdefghijklmnopqrst"]),
      other)).not.toThrow();
    expect(() => assertImportTarget(parseImportArgs(["--commit"]), production)).toThrow(/non-local host/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "fivatgdpuenszxxnijpc"]),
      production)).not.toThrow();
  });

  it("accepts only the exact https://<ref>.supabase.co API URL for a remote commit (Sol W4 r2 BLOCK 2)", () => {
    const flags = parseImportArgs(["--commit", "--production", "--project-ref", "fivatgdpuenszxxnijpc"]);
    expect(() => assertImportTarget(flags, "https://fivatgdpuenszxxnijpc.supabase.co")).not.toThrow();
    expect(() => assertImportTarget(flags, "https://fivatgdpuenszxxnijpc.supabase.co/")).not.toThrow();
    for (const spoof of [
      "https://fivatgdpuenszxxnijpc.attacker.example",
      "https://fivatgdpuenszxxnijpc.supabase.co.evil.com",
      "https://fivatgdpuenszxxnijpc.supabase.co:8443",
      "https://user:pass@fivatgdpuenszxxnijpc.supabase.co",
      "https://user@fivatgdpuenszxxnijpc.supabase.co",
      "http://fivatgdpuenszxxnijpc.supabase.co",
      "ftp://fivatgdpuenszxxnijpc.supabase.co",
      "https://fivatgdpuenszxxnijpc.supabase.co/rest/v1",
      "https://fivatgdpuenszxxnijpc.supabase.co/?x=1",
      "https://fivatgdpuenszxxnijpc.supabase.co/#x",
      "https://FIVATGDPUENSZXXNIJPC.supabase.co.",
      "https://x.fivatgdpuenszxxnijpc.supabase.co",
      "https://aws-0-us-east-1.pooler.supabase.com",
      "postgresql://postgres.fivatgdpuenszxxnijpc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    ]) expect(() => assertImportTarget(flags, spoof), spoof).toThrow();
  });

  it("refuses production flags on a local stack, unknown flags and an unidentifiable host", () => {
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "x"]),
      "http://127.0.0.1:54321")).toThrow(/local stack/);
    expect(() => assertImportTarget(parseImportArgs(["--production"]), "http://127.0.0.1:54321")).toThrow(/--commit/);
    expect(() => parseImportArgs(["--fix"])).toThrow(/unknown argument/);
    expect(() => parseImportArgs(["--dry-run", "--commit"])).toThrow(/exclude/);
    expect(() => parseImportArgs(["--project-ref"])).toThrow(/needs a value/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "db"]),
      "https://db.example.com")).toThrow(/exactly https/);
    expect(() => assertImportTarget(parseImportArgs(["--commit", "--production", "--project-ref", "abcdefghijklmnopqrst"]),
      "https://abcdefghijklmnopqrst.supabase.co/?x=fivatgdpuenszxxnijpc")).toThrow(/exactly https/);
  });
});

describe("release identity (Sol W4 r1 BLOCK 1)", () => {
  const good = (): ReleaseEvidence => ({ zipSha256: FNDDS_RELEASE.zipSha256,
    files: { "fndds/2021-2023/input_food.csv": ["a", "a"], "fndds/2021-2023/survey_fndds_food.csv": ["b", "b"] },
    ledgerSha256: FNDDS_RELEASE.zipSha256,
    versions: [{ id: 3, source: "fdc_fndds", version_label: FNDDS_RELEASE.versionLabel, is_active: true },
      { id: 1, source: "fdc_fndds", version_label: "2026-06-01", is_active: false }],
    zipRows: [{ fdcId: "2705383", description: "Milk, human", contentHash: "h1", nutrients: [], portions: [] }],
    dbRows: [{ fdcId: "2705383", description: "Milk, human", contentHash: "h1", nutrients: [], portions: [] }] });

  it("proves the pinned release and names its catalog version", () => {
    expect(releaseFindings(good())).toEqual({ findings: [], versionId: 3 });
  });

  it("refuses another zip, a file not from the zip, another ledger entry, a missing or inactive version", () => {
    const cases: [string, (e: ReleaseEvidence) => void, RegExp][] = [
      ["zip", (e) => { e.zipSha256 = "0".repeat(64); }, /workspace zip/],
      ["member", (e) => { e.files["fndds/2021-2023/input_food.csv"] = ["a", "z"]; }, /not the file inside/],
      ["ledger", (e) => { e.ledgerSha256 = null; }, /import ledger/],
      ["version", (e) => { e.versions = e.versions.filter((v) => v.id !== 3); }, /0 fdc_fndds version/],
      ["inactive", (e) => { e.versions[0].is_active = false; }, /not the active/],
      ["fingerprint", (e) => { e.dbRows = [{ ...e.dbRows[0], description: "Milk, cow" }]; }, /1 changed/],
      ["empty", (e) => { e.zipRows = []; e.dbRows = []; }, /do not match the pinned zip/],
    ];
    for (const [, mutate, message] of cases) {
      const evidence = good();
      mutate(evidence);
      const result = releaseFindings(evidence);
      expect(result.versionId).toBeNull();
      expect(result.findings.join()).toMatch(message);
    }
  });
});

describe("atomic dish writes (Sol W4 r1 WARN 2)", () => {
  const row = (revision: number, seq: number, food = 1): InputRow => ({ food_revision_id: revision, seq,
    input_catalog_food_id: food, grams: 1, source: "fndds", estimated: true });

  it("sends every planned row of each changed dish, and no unchanged dish", () => {
    const planned = [row(1, 1), row(1, 2), row(2, 1), row(3, 1)];
    const diff = { upserts: [row(1, 2)], deletes: [{ food_revision_id: 3, seq: 2 }], unchanged: 2 };
    expect(replaceBatches(planned, diff).flat()).toEqual([row(1, 1), row(1, 2), row(3, 1)]);
  });

  it("a failure mid-run leaves every dish fully old or fully new, never mixed", async () => {
    // The table as stored: two dishes of old rows (input food 9).
    let table = [row(1, 1, 9), row(1, 2, 9), row(2, 1, 9), row(2, 2, 9), row(2, 3, 9)];
    const planned = [row(1, 1), row(1, 2), row(2, 1), row(2, 2)];
    const batches = replaceBatches(planned, diffRows(planned, table, new Set([1, 2])), 2);
    let calls = 0;
    // The RPC's contract: all of a call or none of it (one transaction). The second call fails.
    const replace: ReplaceDishes = async (revisions, rows) => {
      calls += 1;
      if (calls === 2) throw new Error("connection reset");
      table = [...table.filter((r) => !revisions.includes(r.food_revision_id)), ...rows];
    };
    await expect(writeDishes(batches, replace)).rejects.toThrow(/connection reset/);
    for (const dish of [1, 2]) {
      const foods = new Set(table.filter((r) => r.food_revision_id === dish).map((r) => r.input_catalog_food_id));
      expect(foods.size).toBe(1);
    }
    expect(table.filter((r) => r.food_revision_id === 1).map((r) => r.input_catalog_food_id)).toEqual([1, 1]);
    expect(table.filter((r) => r.food_revision_id === 2)).toHaveLength(3);
  });
});

describe("the post-write recheck (Sol W4 r2 WARN 3)", () => {
  it("passes only when the same version still holds the same release", () => {
    expect(postWriteFindings(3, { findings: [], versionId: 3 })).toEqual([]);
    expect(postWriteFindings(3, { findings: ["release: catalog version 3 (2026-09-12) is not the active fdc_fndds version"],
      versionId: null }).join()).toMatch(/changed during the import/);
    expect(postWriteFindings(3, { findings: [], versionId: 4 })).toHaveLength(1);
  });
});
