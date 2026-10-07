// 2026-09-14: production was missing four migrations (20261013090200, 20261014090000,
// 20261014090001, 20261015000000) and nobody noticed. Nothing in CI or the deploy path compares
// the repo's migrations against the ones production has actually applied: Vercel's Git
// integration builds the app only, and ci.yml has no migration step. So `_sync_upsert` and
// `catalog_write_provider_revision` ran in production as their pre-fix versions for a day while
// the repo said otherwise. This is the check that makes that state loud instead of silent.
import { describe, expect, it } from "vitest";
import { diffMigrations, versionFromFilename } from "@/lib/migrations/drift";

describe("versionFromFilename", () => {
  it("takes the leading timestamp off a migration filename", () => {
    expect(versionFromFilename("20261014090001_fix_duplicate_groups.sql")).toBe("20261014090001");
  });

  it("ignores anything that is not a migration file", () => {
    expect(versionFromFilename("README.md")).toBeNull();
    expect(versionFromFilename("down")).toBeNull();
    expect(versionFromFilename("no_leading_timestamp.sql")).toBeNull();
  });
});

describe("diffMigrations", () => {
  it("is clean when both sides carry the same versions", () => {
    expect(diffMigrations(["20260101000000", "20260102000000"],
      ["20260101000000", "20260102000000"]))
      .toEqual({ missing: [], unknown: [], clean: true });
  });

  it("names every repo migration the database has not applied, in order", () => {
    // The exact 2026-09-14 drift, smallest-first: this is the case that was silent.
    const repo = ["20261013090000", "20261013090200", "20261014090000", "20261014090001",
      "20261015000000"];
    const applied = ["20261013090000"];
    expect(diffMigrations(repo, applied)).toEqual({
      missing: ["20261013090200", "20261014090000", "20261014090001", "20261015000000"],
      unknown: [], clean: false,
    });
  });

  it("names a migration the database has that the repo does not — a rollback or a hand-applied one", () => {
    expect(diffMigrations(["20260101000000"], ["20260101000000", "20269999000000"]))
      .toEqual({ missing: [], unknown: ["20269999000000"], clean: false });
  });

  it("does not care what order either side arrives in", () => {
    expect(diffMigrations(["20260102000000", "20260101000000"],
      ["20260101000000", "20260102000000"]).clean).toBe(true);
  });

  it("treats an empty database as every migration missing, not as clean", () => {
    expect(diffMigrations(["20260101000000"], [])).toEqual({
      missing: ["20260101000000"], unknown: [], clean: false,
    });
  });
});
