import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { formatRow, readOnlyClient, reasonCodes, reportRows, type Row } from "@/scripts/recipe-coverage";

describe("recipe coverage harness", () => {
  const client = readOnlyClient(createClient("http://127.0.0.1:1", "test-key",
    { auth: { persistSession: false } }));

  it("refuses every write and RPC before a request is made", () => {
    for (const method of ["insert", "upsert", "update", "delete"] as const) {
      expect(() => (client.from("recipe_catalog")[method] as (v?: unknown) => unknown)({}))
        .toThrow(`read-only harness: ${method} on recipe_catalog refused`);
    }
    expect(() => client.rpc("recipe_log_consumed")).toThrow("rpc refused");
  });

  it("refuses writes through a schema-scoped client, storage and functions", () => {
    const scoped = client.schema("public");
    for (const method of ["insert", "upsert", "update", "delete"] as const) {
      expect(() => (scoped.from("recipe_catalog")[method] as (v?: unknown) => unknown)({}))
        .toThrow(`read-only harness: ${method} on recipe_catalog refused`);
    }
    expect(() => scoped.rpc("recipe_log_consumed")).toThrow("rpc refused");
    expect(() => client.storage).toThrow("storage refused");
    expect(() => client.functions).toThrow("functions refused");
    expect(() => client.auth).toThrow("auth refused");
    expect(() => client.auth.admin).toThrow("auth refused");
    expect(typeof scoped.from("recipe_catalog").select("id").eq).toBe("function");
  });

  it("never prints or saves recipe names for an account row, only counts and codes", () => {
    const leaky: Row = { scenario: "query:salmon", profile: "account", count: 2,
      names: ["Secret salmon plate"], reasons: [] };
    expect(formatRow(leaky)).toBe("account    2  query:salmon");
    expect(JSON.stringify(reportRows([leaky]))).not.toContain("Secret");
    const empty: Row = { scenario: "query:beef", profile: "account", count: 0,
      reasons: reasonCodes(["Some recipes conflict with your Avoid list or food rules.",
        "Some ingredients need preference or restriction evidence before they can be recommended."]) };
    expect(formatRow(empty)).toBe("account    0  query:beef  (rules_conflict, evidence_missing)");
    const open: Row = { scenario: "query:salmon", profile: "no-rules", count: 1,
      names: ["Salmon plate"], reasons: [] };
    expect(formatRow(open)).toContain("[Salmon plate]");
    expect(reportRows([open])[0].names).toEqual(["Salmon plate"]);
  });

  it("keeps select available", () => {
    expect(typeof client.from("recipe_catalog").select("id").eq).toBe("function");
  });
});
