import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coachTurnRequestSchema } from "@/lib/coach/types";
import { HttpError } from "@/lib/server/auth";
import { TURN_SAVE_DEADLINE_MS } from "@/lib/coach/turn";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const USER = "3f1b1a2c-0000-4000-8000-000000000001";
const FOOD_REF = "3f1b1a2c-0000-4000-8000-000000000002";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000003";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000004";
const MEDIA = `media/${USER}/3f1b1a2c-0000-4000-8000-000000000005.jpg`;
const OTHER_USER = "3f1b1a2c-0000-4000-8000-000000000099";

type Row = Record<string, unknown>;
type Write = { table: string; row: Row };

function database(
  initial: Record<string, Row[]> = {},
  readErrors: Record<string, { message: string }> = {},
) {
  const tables = Object.fromEntries(
    Object.entries(initial).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  ) as Record<string, Row[]>;
  const writes: Write[] = [];
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let max: number | undefined;
    let ascending = true;
    let countOnly = false;
    const rows = () => {
      const selected = (tables[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
      if (table === "coach_messages") {
        selected.sort((a, b) => (Number(a.seq) - Number(b.seq)) * (ascending ? 1 : -1));
      }
      return selected.slice(0, max);
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: (_columns: string, options?: { head?: boolean }) => {
        countOnly = options?.head === true; return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      gte: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column]) >= Number(value));
        return chain;
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column]) <= Number(value));
        return chain;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value || row[column] === undefined && value === null);
        return chain;
      },
      order: (_column: string, opts?: { ascending?: boolean }) => {
        ascending = opts?.ascending ?? true;
        return chain;
      },
      limit: (value: number) => { max = value; return chain; },
      range: () => chain,
      maybeSingle: async () => readErrors[table]
        ? ({ data: null, error: readErrors[table] })
        : ({ data: rows()[0] ?? null, error: null }),
      insert: (value: Row) => {
        writes.push({ table, row: value });
        (tables[table] ??= []).push(value);
        return chain;
      },
      update: (value: Row) => { writes.push({ table, row: value }); return chain; },
      then: (resolve: (result: { data: Row[] | null; error: { message: string } | null }) => unknown) =>
        Promise.resolve(readErrors[table]
          ? { data: null, error: readErrors[table] }
          : { data: rows(), count: countOnly ? rows().length : null, error: null }).then(resolve),
    });
    return chain;
  };
  return { client: { from, rpc: async () => ({ data: null, error: null }) } as never,
    tables, writes };
}

function catalog(status?: "eats" | "avoid", policyCategories: string[] = []) {
  return {
    catalog_food_revisions: [{
      id: 71, catalog_food_id: 7, description: "Plain rice", brand: null,
      category: "Grains", policy_categories: policyCategories, quality_class: "analytical",
      quality_flags: [], catalog_versions: { version_label: "2026-09" },
      catalog_food_nutrients: [
        { nutrient_code: "energy_kcal", amount_per_100g: 130 },
        { nutrient_code: "protein", amount_per_100g: 2.7 },
      ],
      catalog_portions: [
        { id: 9, description: "1 cup", gram_weight: 158, is_default: true, seq: 1 },
      ],
      catalog_ingredients: [{ seq: 1, allergen_tags: [], raw_text: "rice" }] as
        { seq: number; name?: string; allergen_tags: string[]; raw_text?: string | null }[],
    }],
    catalog_barcodes: [{ gtin14: "00012345678905", catalog_food_id: 7, source: "fdc_branded" }],
    food_refs: [{ id: FOOD_REF, catalog_food_id: 7 }],
    constraint_profiles: [{
      avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
      banned_categories: ["simple_sugars"],
    }],
    ...(status ? { user_food_prefs: [{ user_id: USER, food_ref_id: FOOD_REF, status }] } : {}),
  };
}

function barcodeRequest(messageId = MESSAGE) {
  return {
    threadId: null, messageId, text: "", now: "2026-09-19T16:00:00.000Z",
    tz: "America/Denver",
    attachment: {
      kind: "barcode" as const, v: 1 as const, gtin14: "00012345678905",
      foodRefId: FOOD_REF, revisionId: "71", localDate: "2026-09-19",
      slot: "meal-2" as const, scannedAt: "2026-09-19T16:00:00.000Z",
    },
  };
}

function captureDraft(method: "photo" | "label") {
  return {
    draftId: "3f1b1a2c-0000-4000-8000-000000000006", method,
    items: [{
      seq: 0, label: "Chicken and rice", foodRefId: FOOD_REF,
      catalogFoodRevisionId: 71, grams: 250, qty: 1, unit: "plate", portionId: null,
      confidence: 0.9, policy: { verdict: "allowed" as const }, alternatives: [],
      autoResolved: true,
    }],
    notes: [], spend: { usedToday: 1, softCap: 20 }, timings: { model: 25, ground: 10 },
  };
}

function ids() {
  const values = [THREAD, "block-1", "assistant-1", "block-2", "assistant-2"];
  return () => values.shift() ?? crypto.randomUUID();
}

function advancingClock() {
  let time = 0;
  return () => {
    const current = time;
    time += 10;
    return current;
  };
}

describe("coach attachment turns", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("persists a policy-clean barcode draft without calling Jev or Gemini", async () => {
    const db = database(catalog());
    const generate = vi.fn();
    const classifyIntent = vi.fn();
    const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      generate: generate as never, classifyIntent: classifyIntent as never,
      now: advancingClock(), newId: ids(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(result.model.modelId).toBe("");
    expect(result.timings).toEqual({ model: 0, ground: 0, attach: 10, "reply-done": 10 });
    expect(result.messages[0]).toMatchObject({ content: "Scanned a barcode",
      attachments: [{ kind: "barcode", revisionId: "71" }] });
    expect(result.messages[1]).toMatchObject({ blocks: [{
      kind: "log_draft", v: 1, source: "barcode", status: "pending",
      localDate: "2026-09-19", policy: { blocked: false },
      draft: { status: "resolved", cached: false, match: {
        foodRefId: FOOD_REF, revisionId: 71,
        portions: [{ id: 9, gramWeight: 158, isDefault: true }],
      } },
    }] });
    const assistant = db.writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    expect(assistant.tool_calls).toMatchObject({ blocks: [{ status: "pending" }] });
    // C8: a barcode draft is catalog data, matched in code — no AI.
    expect(result.provenance).toEqual({ ai: false, source: "app" });
    expect(result.messages[1]).toMatchObject({ provenance: { ai: false, source: "app" },
      blocks: [{ provenance: { ai: false, source: "app" } }] });
  });

  it("blocks a barcode attachment whose ingredient text names an account-defined allergen, " +
    "the same as the scan card would (finding #10: this path rebuilt policy without the new " +
    "evidence machinery)", async () => {
    const seeded = catalog();
    seeded.catalog_food_revisions[0].catalog_ingredients =
      [{ seq: 1, allergen_tags: [], raw_text: "Rice, apple juice concentrate" }];
    const db = database(seeded);
    const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
      classifyIntent: vi.fn(() => { throw new Error("Jev must not run"); }) as never,
      now: () => 0, newId: ids(),
    });
    expect(result.messages[1]).toMatchObject({ blocks: [{
      policy: { blocked: true, reason: "allergen:apple" },
      draft: { match: { policy: { verdict: "blocked", reason: "allergen:apple" } } },
    }] });
  });

  it("blocks a barcode attachment when a later ingredient row carries its own split raw_text " +
    "that seq 1's own text does not include (finding #2: catalog readers must not clear an " +
    "allergen using only part of a split label — the seq-1 fragment alone must not stand in " +
    "for the whole verbatim statement when a later row proves it is not the whole thing)",
    async () => {
      const seeded = catalog();
      seeded.catalog_food_revisions[0].catalog_ingredients = [
        { seq: 1, allergen_tags: [], raw_text: "Water, rice, salt." },
        { seq: 2, allergen_tags: [], raw_text: "Peanut oil." },
      ];
      seeded.constraint_profiles[0].avoid_allergens = ["peanut"];
      const db = database(seeded);
      const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
        generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
        classifyIntent: vi.fn(() => { throw new Error("Jev must not run"); }) as never,
        now: () => 0, newId: ids(),
      });
      expect(result.messages[1]).toMatchObject({ blocks: [{
        policy: { blocked: true, reason: "allergen:peanut" },
        draft: { match: { policy: { verdict: "blocked", reason: "allergen:peanut" } } },
      }] });
    });

  it("blocks a barcode attachment when a later ingredient row carries only a parsed NAME " +
    "naming an allergen, with empty allergen_tags and no raw_text of its own (finding: " +
    "coach-attachments.ts barcodeDraft built allergenTags from the revision's structured " +
    "allergen_tags alone, unlike lib/server/barcode.ts toMatch's own scannedAllergenTags helper, " +
    "which also scans the parsed ingredient NAMES search and detail already scan)",
    async () => {
      const seeded = catalog();
      seeded.catalog_food_revisions[0].catalog_ingredients = [
        { seq: 1, allergen_tags: [], raw_text: "Water, rice, salt." },
        { seq: 2, name: "peanut", allergen_tags: [] },
      ];
      seeded.constraint_profiles[0].avoid_allergens = ["peanut"];
      const db = database(seeded);
      const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
        generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
        classifyIntent: vi.fn(() => { throw new Error("Jev must not run"); }) as never,
        now: () => 0, newId: ids(),
      });
      expect(result.messages[1]).toMatchObject({ blocks: [{
        policy: { blocked: true, reason: "allergen:peanut" },
        draft: { match: { policy: { verdict: "blocked", reason: "allergen:peanut" } } },
      }] });
    });

  it("re-evaluates the user's Avoid mark", async () => {
    const db = database(catalog("avoid"));
    const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
      classifyIntent: vi.fn(() => { throw new Error("Jev must not run"); }) as never,
      now: () => 0, newId: ids(),
    });
    expect(result.messages[1]).toMatchObject({ blocks: [{
      policy: { blocked: true, reason: "avoid_list", blockedItemIds: [FOOD_REF] },
      draft: { match: { policy: { verdict: "blocked", reason: "avoid_list" } } },
    }] });
  });

  it("re-evaluates the user's banned categories", async () => {
    const db = database(catalog(undefined, ["simple_sugars"]));
    const result = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
      classifyIntent: vi.fn(() => { throw new Error("Jev must not run"); }) as never,
      now: () => 0, newId: ids(),
    });
    expect(result.messages[1]).toMatchObject({ blocks: [{
      policy: { blocked: true, reason: "category:simple_sugars" },
      draft: { match: { policy: { verdict: "blocked", reason: "category:simple_sugars" } } },
    }] });
  });

  it.each([
    ["preference", "user_food_prefs", "policy_failed"],
    ["profile", "constraint_profiles", "policy_failed"],
  ])("fails the turn when the %s policy read fails", async (_label, table, code) => {
    const db = database(catalog("avoid"), { [table]: { message: "read failed" } });
    const error = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      now: () => 0, newId: ids(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, code });
    expect(db.writes.filter((write) => write.table === "coach_messages")).toEqual([]);
  });

  it.each(["catalog_barcodes", "food_refs"])(
    "returns catalog_failed when the %s read fails",
    async (table) => {
      const db = database(catalog(), { [table]: { message: "read failed" } });
      const error = await runTurn(db.client, db.client, USER, barcodeRequest(), {
        now: () => 0, newId: ids(),
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 500, code: "catalog_failed" });
      expect(db.writes.filter((write) => write.table === "coach_messages")).toEqual([]);
    },
  );

  it("rejects a barcode whose GTIN, revision and food ref do not agree", async () => {
    const tables = catalog();
    tables.food_refs[0].catalog_food_id = 999;
    const db = database(tables);
    const error = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      now: () => 0, newId: ids(),
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, code: "attachment_mismatch" });
    expect(db.writes.filter((write) => write.table === "coach_messages")).toEqual([]);
  });

  it("replays a messageId without another write or AI call", async () => {
    const db = database(catalog());
    const generate = vi.fn();
    const classifyIntent = vi.fn();
    const deps = { generate: generate as never, classifyIntent: classifyIntent as never,
      now: () => 0, newId: ids() };
    const first = await runTurn(db.client, db.client, USER, barcodeRequest(), deps);
    // The first turn writes its sanity result back after the reply (C3b); let that settle so the
    // count below measures the replay alone.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = db.writes.length;
    const replay = await runTurn(db.client, db.client, USER, barcodeRequest(), deps);
    expect(replay.threadId).toBe(first.threadId);
    expect(replay.messages).toEqual(first.messages);
    expect(replay.provenance).toEqual(first.provenance);
    expect(replay.timings).toEqual({ model: 0, ground: 0, attach: 0, "reply-done": 0 });
    expect(db.writes).toHaveLength(writes);
    expect(generate).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("replays an attachment turn the server saved after answering 503 (Sol r3)", async () => {
    const db = database(catalog());
    const deps = { now: () => 0, newId: ids() };
    await runTurn(db.client, db.client, USER, barcodeRequest(), deps);  // the late save
    await new Promise((resolve) => setTimeout(resolve, 0));             // its sanity write-back
    const writes = db.writes.length;
    const retry = await runTurn(db.client, db.client, USER, barcodeRequest(), deps);
    expect(retry.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(db.writes).toHaveLength(writes);
  });

  it("does not replay an attachment turn whose reply has not landed yet", async () => {
    const db = database(catalog());
    db.tables.coach_threads = [{ id: THREAD, user_id: USER, kind: "chat", deleted_at: null }];
    db.tables.coach_messages = [{ id: MESSAGE, thread_id: THREAD, user_id: USER, role: "user",
      content: "Scanned a barcode", seq: 1, tool_calls: {}, created_at: new Date().toISOString() }];
    const error = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      now: () => 0, newId: ids() }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 503, code: "in_progress" });
  });

  it("refuses a ninth new attachment before the capture model runs", async () => {
    const db = database({ coach_threads: Array.from({ length: 8 }, (_, index) => ({
      id: `chat-${index}`, user_id: USER, kind: "chat", deleted_at: null,
    })) });
    const propose = vi.fn();
    await expect(runTurn(db.client, db.client, USER, { ...barcodeRequest(),
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: () => 0, newId: ids() }))
      .rejects.toMatchObject({ status: 409, code: "chat_limit" });
    expect(propose).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("does not replay an assistant message ID as an attachment turn", async () => {
    const db = database({ coach_threads: [{ id: THREAD, user_id: USER,
      kind: "chat", deleted_at: null }], coach_messages: [{ id: MESSAGE,
      thread_id: THREAD, user_id: USER, role: "assistant", content: "old reply",
      seq: 2, tool_calls: {}, created_at: new Date().toISOString() }] });
    await expect(runTurn(db.client, db.client, USER, barcodeRequest(), {
      now: () => 0, newId: ids(),
    })).rejects.toMatchObject({ status: 404 });
  });

  it("fails closed when the replay lookup errors", async () => {
    const db = database(catalog(), { coach_messages: { message: "read failed" } });
    const error = await runTurn(db.client, db.client, USER, barcodeRequest(), {
      now: () => 0, newId: ids(),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, code: "internal" });
    expect(db.writes).toEqual([]);
  });

  it("saves nothing when the proposal lands after the turn's save deadline (Sol review)", async () => {
    const db = database();
    const propose = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return captureDraft("photo");
    });
    const error = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "", tz: "America/Denver",
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: advancingClock(), newId: ids(),
      startedAt: Date.now() - TURN_SAVE_DEADLINE_MS + 40 }).catch((caught) => caught);
    expect(error).toMatchObject({ status: 503, code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(db.writes.filter((write) => write.table === "coach_messages")).toEqual([]);
  });

  it("runs only proposeDraft for a capture attachment", async () => {
    const db = database();
    const propose = vi.fn().mockResolvedValue(captureDraft("photo"));
    const generate = vi.fn();
    const classifyIntent = vi.fn();
    const result = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "", tz: "America/Denver",
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19", slot: "meal-2" },
    }, { generate: generate as never, classifyIntent: classifyIntent as never,
      attachment: { propose }, now: advancingClock(), newId: ids() });

    expect(propose).toHaveBeenCalledOnce();
    expect(propose.mock.calls[0][3]).toMatchObject({
      method: "photo", mediaPath: MEDIA, localDate: "2026-09-19", slot: "meal-2",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(result.timings).toEqual({ model: 0, ground: 0, attach: 10, "reply-done": 10 });
    expect(result.messages[0]).toMatchObject({ content: "Sent a photo" });
    expect(result.messages[1]).toMatchObject({ blocks: [{ source: "capture", method: "photo" }] });
    // C8: the draft is the capture model's read, so the reply and its draft card say AI.
    expect(result.provenance).toEqual({ ai: true, source: "model" });
    expect(result.messages[1]).toMatchObject({ provenance: { ai: true, source: "model" },
      blocks: [{ provenance: { ai: true, source: "model" } }] });
  });

  it("does not invent a slot for a slot-less capture", async () => {
    const db = database();
    const propose = vi.fn().mockResolvedValue(captureDraft("photo"));
    const result = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "", tz: "America/Denver",
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: () => 0, newId: ids() });

    expect(propose.mock.calls[0][3]).not.toHaveProperty("slot");
    expect(result.messages[1]).toMatchObject({ blocks: [{ source: "capture" }] });
    expect(result.messages[1].blocks?.[0]).not.toHaveProperty("slot");
  });

  it("rejects another user's media path before proposeDraft", async () => {
    const db = database();
    const propose = vi.fn().mockResolvedValue(captureDraft("photo"));
    const error = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "", tz: "America/Denver",
      attachment: { kind: "capture", v: 1, method: "photo",
        mediaPath: `media/${OTHER_USER}/3f1b1a2c-0000-4000-8000-000000000005.jpg`,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: () => 0, newId: ids() }).catch((caught) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, code: "attachment_mismatch" });
    expect(propose).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("keeps attachment turns in the canonical request schema", () => {
    const attachment = {
      kind: "capture" as const, v: 1 as const, method: "photo" as const, mediaPath: MEDIA,
      localDate: "2026-09-19",
    };
    expect(coachTurnRequestSchema.safeParse({
      threadId: null, messageId: MESSAGE, text: "", attachment,
    }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({
      threadId: null, messageId: MESSAGE, text: "",
    }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({
      threadId: null, messageId: MESSAGE, text: "",
      attachment: { ...attachment, mediaPath: MEDIA.replace(/\.jpg$/, ".m4a") },
    }).success).toBe(false);
  });

  it("persists an honest 200-style reply when the capture model fails", async () => {
    const db = database();
    const result = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "",
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose: vi.fn().mockRejectedValue(
      new HttpError(503, "provider_unavailable", "down")) }, now: () => 0, newId: ids() });

    expect(result.messages[1]).toMatchObject({
      content: "I couldn't read that photo. Try again or search.",
    });
    expect("blocks" in result.messages[1]).toBe(false);
    const assistant = db.writes.filter((write) => write.table === "coach_messages").at(-1)!.row;
    // The reply is the app's own line, not a model's read (C8).
    expect(assistant.tool_calls).toEqual({ provenance: { ai: false, source: "app" } });
    expect(result.provenance).toEqual({ ai: false, source: "app" });
    expect(result.messages[1].provenance).toEqual({ ai: false, source: "app" });
  });

  it("allows a label rerun against the same media path", async () => {
    const db = database();
    const propose = vi.fn()
      .mockResolvedValueOnce(captureDraft("photo"))
      .mockResolvedValueOnce(captureDraft("label"));
    const newId = ids();
    const first = await runTurn(db.client, db.client, USER, {
      threadId: null, messageId: MESSAGE, text: "",
      attachment: { kind: "capture", v: 1, method: "photo", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: () => 0, newId });
    const second = await runTurn(db.client, db.client, USER, {
      threadId: first.threadId, messageId: "3f1b1a2c-0000-4000-8000-000000000007", text: "",
      attachment: { kind: "capture", v: 1, method: "label", mediaPath: MEDIA,
        localDate: "2026-09-19" },
    }, { attachment: { propose }, now: () => 1, newId });

    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls.map((call) => call[3])).toMatchObject([
      { method: "photo", mediaPath: MEDIA }, { method: "label", mediaPath: MEDIA },
    ]);
    expect(second.messages[1]).toMatchObject({ blocks: [{ method: "label" }] });
  });
});
