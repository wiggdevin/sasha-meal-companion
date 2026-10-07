import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lookupTool, REGISTRY, TOOL_NAMES } from "@/lib/coach/registry";

/** Every property name anywhere in a tool's JSON Schema, at any depth. */
function propertyNames(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      out.push(...Object.keys(record.properties as Record<string, unknown>));
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(z.toJSONSchema(schema));
  return out;
}

const FORBIDDEN = ["user", "user_id", "userid", "account", "accountid", "owner",
  "url", "uri", "href", "endpoint", "webhook", "callback", "destination", "email"];

describe("the coach tool registry", () => {
  it("lists exactly 15 tools, in a frozen order", () => {
    expect(REGISTRY).toHaveLength(15);
    expect([...TOOL_NAMES]).toEqual([
      "get_day", "get_plan", "get_entries", "get_recipes", "get_week_totals", "get_targets",
      "get_expenditure_status", "search_foods", "lookup", "get_constraints", "get_recent_gut_log",
      "draft_log_entry", "compose_meal", "suggest_options", "preview_skip",
    ]);
  });

  it("marks 12 tools read, and only the three that write nothing draft", () => {
    expect(REGISTRY.filter((t) => t.effect === "read")).toHaveLength(12);
    const draft = REGISTRY.filter((t) => t.effect === "draft");
    expect(draft.map((t) => t.name)).toEqual(["draft_log_entry", "compose_meal", "suggest_options"]);
  });

  it("bounds lookup to one call a turn and a short subject (§9 R8)", () => {
    const tool = lookupTool("lookup")!;
    expect(tool.maxCallsPerTurn).toBe(1);
    expect(tool.effect).toBe("read");
    expect(tool.input.safeParse({ subject: "a".repeat(80) }).success).toBe(true);
    expect(tool.input.safeParse({ subject: "a".repeat(81) }).success).toBe(false);
    expect(tool.input.safeParse({ subject: "" }).success).toBe(false);
    expect(tool.input.safeParse({}).success).toBe(false);
  });

  it("has no user, account or url field in any schema, at any depth", () => {
    for (const tool of REGISTRY) {
      for (const name of propertyNames(tool.input)) {
        expect(FORBIDDEN, `${tool.name}.${name}`).not.toContain(name.toLowerCase());
      }
    }
  });

  it("caps every tool at a positive number of calls per turn", () => {
    for (const tool of REGISTRY) {
      expect(tool.maxCallsPerTurn).toBeGreaterThan(0);
      // search_foods runs once per food, so a six-food meal fits; every other tool stays at 3.
      expect(tool.maxCallsPerTurn).toBeLessThanOrEqual(tool.name === "search_foods" ? 6 : 3);
    }
    expect(lookupTool("draft_log_entry")!.maxCallsPerTurn).toBe(1);
  });

  it("gives every tool a description the model can act on", () => {
    for (const tool of REGISTRY) expect(tool.description.length).toBeGreaterThan(20);
  });

  it("looks a tool up by value, never by property access", () => {
    expect(lookupTool("get_day")!.name).toBe("get_day");
    expect(lookupTool("__proto__")).toBeUndefined();
    expect(lookupTool("constructor")).toBeUndefined();
    expect(lookupTool("prototype")).toBeUndefined();
    expect(lookupTool("toString")).toBeUndefined();
    expect(lookupTool("set_targets")).toBeUndefined();
  });

  it("validates draft_log_entry items against the ritual slot list", () => {
    const tool = lookupTool("draft_log_entry")!;
    expect(tool.input.safeParse({ slot: "meal-2", items: [{ name: "rice", grams: 150 }] }).success)
      .toBe(true);
    expect(tool.input.safeParse({ slot: "second-breakfast", items: [{ name: "rice", grams: 150 }] })
      .success).toBe(false);
    expect(tool.input.safeParse({ slot: "meal-2", items: [] }).success).toBe(false);
  });

  it("defaults suggestion count to three and bounds it from one to five", () => {
    const tool = lookupTool("suggest_options")!;
    expect(tool.input.parse({ kind: "snack" })).toEqual({ kind: "snack", count: 3 });
    expect(tool.input.safeParse({ kind: "meal", count: 5 }).success).toBe(true);
    expect(tool.input.safeParse({ kind: "recipe", count: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "snack", count: 6 }).success).toBe(false);
  });
});
