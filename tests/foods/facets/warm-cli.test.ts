import { spawnSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const systemOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

const { ensureFacets } = await import("@/lib/foods/facet-warm");
const { FACETS } = await import("@/lib/foods/facets");
const { parseArgs, requireAccountingUser, runWarmFacets } =
  await import("../../../scripts/warm-facets");

function admin() {
  const upsert = vi.fn(async () => ({ data: null, error: null }));
  const response = { data: [], error: null };
  const query = {
    eq: vi.fn(), in: vi.fn(), or: vi.fn(), order: vi.fn(), range: vi.fn(),
    then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
  };
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  for (const name of ["or", "order", "range"] as const) query[name].mockReturnValue(query);
  const client = ({ from: vi.fn(() => ({ select: vi.fn(() => query), upsert })) }) as unknown as SupabaseClient;
  return { client, upsert };
}

function row(id: number, ingredientsText = "rice, water") {
  return {
    id, description: `Food ${id}`, brand: null, category: "meal", prep_state: null,
    catalog_ingredients: [{ seq: 1, name: "rice", raw_text: ingredientsText }],
    catalog_portions: [],
  };
}

function allYes(questions: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(questions).map((key) =>
    [key, { type: "noul", noul: 0.9 }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  systemOneMock.mockImplementation(async (_state, questions) => allYes(questions));
});

describe("warm-facets CLI core", () => {
  it("plans --dry-run --limit 2 with no accounting id, no provider call, and no writes", async () => {
    const db = admin();
    const limits: number[] = [];
    const log = vi.fn();
    const result = await runWarmFacets(parseArgs(["--dry-run", "--limit", "2"], {}), {
      admin: db.client,
      ensureFacets,
      loadCatalogPage: async (_admin, after, limit) => {
        limits.push(limit);
        return after === 0 ? [row(1), row(2), row(3)].slice(0, limit) : [];
      },
      loadCursor: () => ({ version: 1, catalogAfter: 0, catalogDone: false,
        userFoodAfter: "", userFoodsDone: false }),
      persistCursor: vi.fn(),
      log,
    });

    expect(limits).toEqual([2]);
    expect(result).toMatchObject({ paused: false, batches: 1,
      totals: { foods: 2, writes: 0 } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("batch 1: 2 food(s)"));
    expect(log).toHaveBeenCalledWith("dry run: 0 writes; cursor unchanged");
    expect(systemOneMock).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("judges a normal food and advances past it plus an oversized food", async () => {
    const db = admin();
    const persist = vi.fn();
    const warn = vi.fn();
    const result = await runWarmFacets(parseArgs([
      "--commit", "--user-id", "accounting-user", "--limit", "2",
    ], {}), {
      admin: db.client,
      ensureFacets,
      loadCatalogPage: async (_admin, after) => after === 0
        ? [row(1, "oversized ".repeat(20_000)), row(2)] : [],
      loadCursor: () => ({ version: 1, catalogAfter: 0, catalogDone: false,
        userFoodAfter: "", userFoodsDone: false }),
      persistCursor: persist,
      log: vi.fn(),
      warn,
    });

    expect(result).toMatchObject({ paused: false, cursor: { catalogAfter: 2 },
      totals: { judged: FACETS.length, unknown: FACETS.length } });
    expect(systemOneMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("catalog_revision:1: oversized"));
    expect(persist.mock.calls.at(-1)?.[1]).toMatchObject({ catalogAfter: 2 });
  });

  it("leaves the cursor unchanged when the provider fails", async () => {
    systemOneMock.mockRejectedValue(new Error("provider failed"));
    const db = admin();
    const persist = vi.fn();
    const result = await runWarmFacets(parseArgs([
      "--commit", "--user-id", "accounting-user", "--limit", "1",
    ], {}), {
      admin: db.client,
      ensureFacets,
      loadCatalogPage: async () => [row(3)],
      loadCursor: () => ({ version: 1, catalogAfter: 0, catalogDone: false,
        userFoodAfter: "", userFoodsDone: false }),
      persistCursor: persist,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ paused: true, cursor: { catalogAfter: 0 },
      totals: { judged: 0, unknown: FACETS.length } });
    expect(persist.mock.calls.at(-1)?.[1]).toMatchObject({ catalogAfter: 0 });
  });

  it("requires an accounting id only for commit mode", () => {
    expect(() => requireAccountingUser(parseArgs(["--commit"], {})))
      .toThrow("--commit requires --user-id");
    expect(() => requireAccountingUser(parseArgs(["--dry-run"], {}))).not.toThrow();
  });

  it.each(["scripts/warm-facets.ts", "scripts/annotate-policy-categories.ts"])(
    "%s exits non-zero before commit work when its accounting id is missing", (script) => {
      const env = { ...process.env };
      delete env.FACET_WARM_USER_ID;
      delete env.SUPABASE_TEST_USER_ID;
      const child = spawnSync("pnpm", ["exec", "tsx", script, "--commit"], {
        cwd: process.cwd(), env, encoding: "utf8",
      });

      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain("--commit requires");
      expect(child.stderr).not.toContain("[typesafe]");
    },
  );
});
