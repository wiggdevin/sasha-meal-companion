import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction } from "@/lib/coach/actions";
import { groundedCoachActionSchema } from "@/lib/coach/actions";
import { uiBlockSchema, type CaptureDraft } from "@/lib/coach/ui-blocks";
import { deterministicSanity } from "@/lib/log/sanity-deterministic";
import { typicalServingSuggestion } from "@/lib/log/serving-identity";
import {
  attachDeterministicCoachSanity, attachDeterministicSanity, sanityDraftFromItem,
  startPersistedCoachSanity,
} from "@/lib/server/coach-sanity";

function clientWrites() {
  const writes: unknown[] = [];
  const client = {
    from: () => ({
      update: (value: unknown) => {
        writes.push(value);
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, writes };
}

const ROOT = process.cwd();
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["'](@\/[^"']+|\.[^"']+)["']/g;

function graphFrom(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(path.join(ROOT, file), "utf8");
    seen.set(file, source);
    for (const [, spec] of source.matchAll(IMPORT_RE)) {
      const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
      const resolved = [".ts", ".tsx", "/index.ts"]
        .map((extension) => `${base}${extension}`)
        .find((candidate) => existsSync(path.join(ROOT, candidate)));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

const food = {
  name: "Rice", grams: 100,
  foodRefId: "33333333-3333-4333-8333-333333333333",
  catalogFoodRevisionId: 77,
  kcalPer100g: 130, proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
  verdict: "unverified" as const,
};

describe("coach sanity integration", () => {
  it("attaches deterministic warnings and the catalog default without changing block v1", () => {
    const draft: CaptureDraft = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: {
        foodRefId: food.foodRefId, catalogFoodId: 7, revisionId: 77,
        description: "Rice", brand: null, source: "fdc_branded", qualityClass: "label",
        qualityFlags: [], per100g: { energy_kcal: 160_000 },
        portions: [{ id: 4, description: "1 bowl", gramWeight: 2, isDefault: true }],
        ingredientsText: "rice", allergenTags: [], attribution: null,
        policy: { verdict: "allowed" },
      },
    };

    const annotated = attachDeterministicSanity(draft, {
      deterministic: deterministicSanity,
      typical: typicalServingSuggestion,
    });

    expect(annotated.match.sanity).toMatchObject({
      status: "warn", warnings: [{ level: "implausible" }],
    });
    expect(annotated.match.typicalServing).toEqual({ grams: 2, label: "1 bowl" });
    expect(uiBlockSchema.safeParse({ kind: "log_draft", v: 1, id: "b", source: "barcode",
      localDate: "2026-09-20", draft: annotated, policy: { blocked: false },
      status: "pending" }).success).toBe(true);
  });

  it("uses the first catalog portion when no default is marked", () => {
    const draft: CaptureDraft = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: {
        foodRefId: food.foodRefId, catalogFoodId: 7, revisionId: 77,
        description: "Rice", brand: null, source: "fdc_branded", qualityClass: "label",
        qualityFlags: [], per100g: { energy_kcal: 130 },
        portions: [{ id: 4, description: "1 bowl", gramWeight: 42, isDefault: false }],
        ingredientsText: "rice", allergenTags: [], attribution: null,
        policy: { verdict: "allowed" },
      },
    };
    const deterministic = vi.fn(deterministicSanity);

    const annotated = attachDeterministicSanity(draft, {
      deterministic,
      typical: typicalServingSuggestion,
    });

    expect(annotated.match.typicalServing).toEqual({ grams: 42, label: "1 bowl" });
    expect(deterministic).toHaveBeenCalledWith(expect.objectContaining({
      amounts: { gramsPerServing: 42, kcalPerServing: 54.6 },
    }));
  });

  it("keeps a portion-less barcode pending for the shared not-human-food check", async () => {
    const draft: CaptureDraft = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: {
        foodRefId: food.foodRefId, catalogFoodId: 7, revisionId: 77,
        description: "Rice", brand: null, source: "fdc_branded", qualityClass: "label",
        qualityFlags: [], per100g: { energy_kcal: 130 }, portions: [],
        ingredientsText: "rice", allergenTags: [], attribution: null,
        policy: { verdict: "allowed" },
      },
    };

    const annotated = attachDeterministicSanity(draft, {
      deterministic: deterministicSanity,
      typical: typicalServingSuggestion,
    });

    expect(annotated.match.typicalServing).toBeUndefined();
    expect(annotated.match.sanity).toEqual({ status: "pending", warnings: [] });

    const { client } = clientWrites();
    const signal = new AbortController().signal;
    const check = vi.fn().mockResolvedValue({
      sanityStatus: "warn", warnings: [{
        itemId: food.foodRefId, kind: "not_food", level: "not_food",
        message: "This may not be food or drink.",
      }],
    });
    const run = startPersistedCoachSanity(client, "user-1", "message-1", {
      blocks: [{ kind: "log_draft", v: 1, id: "b", source: "barcode",
        localDate: "2026-09-20", draft: annotated, policy: { blocked: false },
        status: "pending" }],
    }, signal, { check, schedule: (task) => void task() });

    await run.settled;
    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      food: expect.objectContaining({ name: "Rice", ingredientsText: "rice" }),
      amounts: { gramsPerServing: null, kcalPerServing: null },
    }), { signal, userId: "user-1" });
  });

  it("attaches a capture item's resolved serving suggestion", () => {
    const draft: CaptureDraft = {
      draftId: "22222222-2222-4222-8222-222222222222", method: "photo",
      items: [{
        seq: 1, label: "Rice crackers", foodRefId: food.foodRefId,
        catalogFoodRevisionId: 77, grams: 60, qty: 2, unit: "cracker", portionId: 4,
        confidence: 0.9, policy: { verdict: "allowed" }, alternatives: [], autoResolved: true,
      }],
      notes: [], spend: { usedToday: 1, softCap: 20 },
    };

    const annotated = attachDeterministicSanity(draft, {
      deterministic: deterministicSanity,
      typical: typicalServingSuggestion,
    });

    expect("status" in annotated ? undefined : annotated.items[0].typicalServing)
      .toEqual({ grams: 30, label: "cracker" });
  });

  it("returns deterministic card state now, then writes the Jev result for replay", async () => {
    const { client, writes } = clientWrites();
    const signal = new AbortController().signal;
    const check = vi.fn().mockResolvedValue({
      sanityStatus: "unknown", warnings: [],
    });
    const action: CoachAction = {
      actionId: "action-1", kind: "log_meal", date: "2026-09-20", slot: "meal-1",
      items: [food], flagged: [],
    };

    const initial = attachDeterministicCoachSanity({
      calls: [], actions: [action], blocks: [],
    }, { deterministic: deterministicSanity });
    const run = startPersistedCoachSanity(
      client, "user-1", "message-1", initial, signal, { check },
    );

    expect(run.actions[0]).toMatchObject({
      kind: "log_meal", items: [{ sanity: { status: "pending", warnings: [] } }],
    });
    await expect(run.settled).resolves.toMatchObject({
      actions: [{ items: [{ sanity: { status: "unknown", warnings: [] } }] }],
    });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      food: { name: "Rice" },
      amounts: { gramsPerServing: 100, kcalPerServing: 130 },
    }), { signal, userId: "user-1" });
    expect(writes).toHaveLength(1);
    const final = writes[0] as { tool_calls: { actions: CoachAction[] } };
    expect(final.tool_calls.actions[0].kind === "log_meal"
      && final.tool_calls.actions[0].items[0].sanity?.status).toBe("unknown");
    expect(groundedCoachActionSchema.safeParse(final.tool_calls.actions[0]).success).toBe(true);
  });

  it("keeps the catalog-default grams when the persisted barcode gets its async check", async () => {
    const { client } = clientWrites();
    const signal = new AbortController().signal;
    const check = vi.fn().mockResolvedValue({ sanityStatus: "ok", warnings: [] });
    const draft: CaptureDraft = {
      status: "resolved", gtin14: "00012345678905", cached: false,
      match: {
        foodRefId: food.foodRefId, catalogFoodId: 7, revisionId: 77,
        description: "Rice", brand: null, source: "fdc_branded", qualityClass: "label",
        qualityFlags: [], per100g: { energy_kcal: 130 },
        portions: [{ id: 4, description: "1 bowl", gramWeight: 2, isDefault: true }],
        ingredientsText: "rice", allergenTags: [], attribution: null,
        policy: { verdict: "allowed" },
      },
    };
    const annotated = attachDeterministicSanity(draft, {
      deterministic: deterministicSanity,
      typical: typicalServingSuggestion,
    });
    const run = startPersistedCoachSanity(client, "user-1", "message-1", {
      blocks: [{ kind: "log_draft", v: 1, id: "b", source: "barcode",
        localDate: "2026-09-20", draft: annotated, policy: { blocked: false },
        status: "pending" }],
    }, signal, { check });

    await run.settled;
    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      amounts: { gramsPerServing: 2, kcalPerServing: 2.6 },
    }), { signal, userId: "user-1" });
  });

  it("spends at most one async sanity check across an eight-item meal", async () => {
    const { client } = clientWrites();
    const check = vi.fn().mockResolvedValue({ sanityStatus: "ok", warnings: [] });
    const action: CoachAction = {
      actionId: "action-8", kind: "log_meal", date: "2026-09-20", slot: "meal-1",
      items: Array.from({ length: 8 }, (_, index) => ({
        ...food, name: `Food ${index + 1}`, foodRefId: `${index + 1}`.padStart(8, "0")
          + "-3333-4333-8333-333333333333",
      })),
      flagged: [],
    };

    const initial = attachDeterministicCoachSanity({
      actions: [action], blocks: [],
    }, { deterministic: deterministicSanity });
    const run = startPersistedCoachSanity(
      client, "user-1", "message-1", initial, new AbortController().signal, {
      check, schedule: (task) => void task(),
      },
    );
    const settled = await run.settled;
    const result = settled.actions?.[0];

    expect(check).toHaveBeenCalledTimes(1);
    expect(result?.kind === "log_meal" ? result.items.map((item) => item.sanity?.status) : [])
      .toEqual(["ok", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  it.each(["lib/capture/propose.ts", "lib/coach/ui-blocks.ts"])(
    "%s reaches neither Jev code nor next/server",
    (entry) => {
      const graph = graphFrom(entry);
      const offenders = [...graph.keys()].filter((file) => file.startsWith("lib/ai/"));
      const nextServer = [...graph].filter(([, source]) => /["']next\/server["']/.test(source))
        .map(([file]) => file);
      expect({ offenders, nextServer }).toEqual({ offenders: [], nextServer: [] });
    },
  );

  it("builds provider input from food and resolved amounts only", () => {
    const item = {
      itemId: "item-1", name: "Cooked rice", brand: "Plain Foods",
      description: "Long grain", preparation: "cooked", ingredientsText: "rice, water",
      grams: 180, kcalPer100g: 128, catalogFoodRevisionId: 77,
      note: "private-note", condition: "private-condition", weight: 123,
    };

    const draft = sanityDraftFromItem(item);

    expect(draft).toMatchObject({
      food: {
        name: "Cooked rice", brand: "Plain Foods", description: "Long grain",
        preparation: "cooked", ingredientsText: "rice, water",
      },
      amounts: { gramsPerServing: 180, kcalPerServing: 230.4 },
    });
    expect(JSON.stringify(draft)).not.toMatch(/private|condition|weight/i);
  });

  it("starts the only turn integration call after the assistant-row persist", () => {
    // Every text turn ends in finish(), the one place the assistant row is saved.
    const source = readFileSync(
      new URL("../../lib/server/coach-turn/finish.ts", import.meta.url), "utf8",
    );
    // `save` is persist bounded by the save deadline (lib/server/coach-turn.ts).
    const persistAt = source.indexOf("await save(client, threadId, [userRow, assistantRow]");
    const sanityAt = source.indexOf("startPersistedCoachSanity(", persistAt);
    expect(persistAt).toBeGreaterThan(0);
    expect(sanityAt).toBeGreaterThan(persistAt);
    expect(source.slice(sanityAt).match(/startPersistedCoachSanity\(/g)).toHaveLength(1);
  });

  it("starts attachment sanity only after the assistant-row persist", () => {
    const source = readFileSync(
      new URL("../../lib/server/coach-attachments.ts", import.meta.url), "utf8",
    );
    const persistAt = source.indexOf("await persist(client, threadId, [userRow, assistantRow]");
    const sanityAt = source.indexOf("startPersistedCoachSanity(", persistAt);
    expect(persistAt).toBeGreaterThan(0);
    expect(sanityAt).toBeGreaterThan(persistAt);
    expect(source.slice(sanityAt).match(/startPersistedCoachSanity\(/g)).toHaveLength(1);
  });
});
