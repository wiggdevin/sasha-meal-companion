import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NAME = "20261024090000_food_facets";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8").toLowerCase();
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8").toLowerCase();

describe("food facets migration", () => {
  it("matches the storage contract and exact compound primary key", () => {
    for (const column of [
      "food_key text not null", "input_hash bytea not null", "facet text not null",
      "rubric_version integer not null", "p numeric(4,3) not null", "model text not null",
      "judged_at timestamptz not null default now()", "user_id uuid null",
    ]) expect(UP).toContain(column);
    expect(UP).toContain("primary key (food_key, input_hash, facet, rubric_version)");
    expect(UP).toContain("check (p >= 0 and p <= 1)");
  });

  it("exposes the table only to service_role under RLS", () => {
    expect(UP).toContain("alter table food_facets enable row level security");
    expect(UP).toContain("alter table food_facets force row level security");
    expect(UP).toContain("for all to service_role");
    expect(UP).toContain("revoke all on table food_facets from public, anon, authenticated");
    expect(UP).toContain("grant all on table food_facets to service_role");
    expect(UP).not.toMatch(/policy[^;]*authenticated/);
    expect(UP).not.toMatch(/grant\s+select[^;]*authenticated/);
  });

  it("has a reversible down migration for derived cache data", () => {
    expect(DOWN).toContain("drop table if exists food_facets");
  });
});
