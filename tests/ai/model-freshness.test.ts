import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FRESHNESS_ISSUE_LABEL, FRESHNESS_ISSUE_TITLE, freshnessFindings, freshnessIssueBody,
  modelFamily, modelVersion, newerModelsFor, parseModelIds, watchedPins,
} from "@/lib/ai/model-freshness";
import { findOpenIssue } from "@/scripts/model-freshness-github";

describe("modelFamily / modelVersion", () => {
  it("reads two flash pins of the same generation family as the same family", () => {
    expect(modelFamily("gemini-3.6-flash")).toBe(modelFamily("gemini-3.8-flash"));
  });

  it("reads a different tier as a different family", () => {
    expect(modelFamily("gemini-3.6-flash")).not.toBe(modelFamily("gemini-3.6-pro"));
  });

  it("extracts a comparable version tuple per token, each dotted part a number", () => {
    expect(modelVersion("gemini-3.6-flash")).toEqual([[3, 6]]);
    expect(modelVersion("gemini-4.0-flash")).toEqual([[4, 0]]);
  });

  it("a model with no version token at all reads as the oldest version", () => {
    expect(modelVersion("deepseek-flash")).toEqual([]);
  });

  it("reads a moving -latest alias as the same family as its versioned models", () => {
    expect(modelFamily("jev-latest")).toBe(modelFamily("jev-2.1"));
  });
});

describe("newerModelsFor", () => {
  it("finds a same-family model with a higher version", () => {
    expect(newerModelsFor("gemini-3.6-flash", ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.6-pro"]))
      .toEqual(["gemini-3.8-flash"]);
  });

  it("returns newest-first when more than one newer model exists", () => {
    expect(newerModelsFor("gemini-3.6-flash", ["gemini-3.7-flash", "gemini-4.0-flash"]))
      .toEqual(["gemini-4.0-flash", "gemini-3.7-flash"]);
  });

  it("returns nothing when the pin is already current", () => {
    expect(newerModelsFor("gemini-3.8-flash", ["gemini-3.6-flash", "gemini-3.8-flash"])).toEqual([]);
  });

  it("returns nothing for a different family, however new", () => {
    expect(newerModelsFor("deepseek-flash", ["gemini-4.0-flash"])).toEqual([]);
  });

  it("reads 3.10 as newer than 3.9, never as 3.1", () => {
    expect(newerModelsFor("gemini-3.9-flash", ["gemini-3.10-flash"])).toEqual(["gemini-3.10-flash"]);
    expect(newerModelsFor("gemini-3.10-flash", ["gemini-3.9-flash"])).toEqual([]);
  });

  it("compares an alias pin against the version last benched for it", () => {
    const benched = { "jev-latest": "jev-2.0" };
    expect(newerModelsFor("jev-latest", ["jev-latest", "jev-1.9", "jev-2.0", "jev-2.1"], benched))
      .toEqual(["jev-2.1"]);
    expect(newerModelsFor("jev-latest", ["jev-latest", "jev-1.0"], { "jev-latest": null }))
      .toEqual(["jev-1.0"]);
  });

  it("is case-insensitive", () => {
    expect(newerModelsFor("gemini-3.6-flash", ["Gemini-3.8-Flash"])).toEqual(["Gemini-3.8-Flash"]);
  });
});

describe("watchedPins", () => {
  it("carries the Gemini and Jev lanes, read live from LANES (§3.4)", () => {
    const pins = watchedPins();
    for (const pin of pins) {
      expect(["google", "typesafe"]).toContain(pin.provider);
    }
    expect(pins.find((p) => p.lane === "converse")).toMatchObject({ model: "gemini-3.6-flash" });
    expect(pins.find((p) => p.lane === "capture")).toMatchObject({ model: "gemini-3.8-flash" });
    expect(pins.find((p) => p.lane === "judge")).toMatchObject({
      provider: "typesafe", model: "jev-latest",
    });
  });
});

describe("freshnessFindings", () => {
  const pins = [
    { lane: "converse" as const, provider: "google" as const, model: "gemini-3.6-flash" },
    { lane: "capture" as const, provider: "google" as const, model: "gemini-3.8-flash" },
    { lane: "judge" as const, provider: "typesafe" as const, model: "jev-latest" },
  ];

  it("reports one finding per pin that has something newer", () => {
    const findings = freshnessFindings(pins, {
      google: ["gemini-3.6-flash", "gemini-3.8-flash"],
      typesafe: ["jev-latest"],
    });
    expect(findings).toEqual([{
      pin: pins[0], newer: ["gemini-3.8-flash"],
    }]);
  });

  it("reports nothing when every pin is current", () => {
    const findings = freshnessFindings([pins[1], pins[2]], {
      google: ["gemini-3.8-flash"], typesafe: ["jev-latest"],
    });
    expect(findings).toEqual([]);
  });

  it("reports every pin with something newer, not just the first", () => {
    const findings = freshnessFindings(pins, {
      google: ["gemini-3.8-flash", "gemini-4.0-flash"], typesafe: ["jev-latest"],
    });
    expect(findings.map((f) => f.pin.lane).sort()).toEqual(["capture", "converse"]);
  });
});

describe("freshnessIssueBody", () => {
  it("names the lane, the pin, and every newer model — never raw API output or a key", () => {
    const body = freshnessIssueBody([{
      pin: { lane: "converse", provider: "google", model: "gemini-3.6-flash" },
      newer: ["gemini-3.8-flash", "gemini-4.0-flash"],
    }]);
    expect(body).toContain("converse");
    expect(body).toContain("gemini-3.6-flash");
    expect(body).toContain("gemini-3.8-flash");
    expect(body).toContain("gemini-4.0-flash");
    expect(body).toContain("never changes a pin");
    expect(body.toLowerCase()).not.toContain("key");
    expect(body.toLowerCase()).not.toContain("token");
  });
});

describe("issue identity", () => {
  it("is a fixed title and label — the workflow always opens or updates the same one", () => {
    expect(FRESHNESS_ISSUE_TITLE.length).toBeGreaterThan(0);
    expect(FRESHNESS_ISSUE_LABEL).toBe("model-freshness");
  });
});

describe("parseModelIds", () => {
  it("reads the Gemini, OpenAI-style and bare-list shapes, dropping a models/ prefix", () => {
    expect(parseModelIds({ models: [{ name: "models/gemini-3.8-flash" }] })).toEqual(["gemini-3.8-flash"]);
    expect(parseModelIds({ data: [{ id: "jev-2.1" }, { id: "" }] })).toEqual(["jev-2.1"]);
    expect(parseModelIds(["jev-latest", 3])).toEqual(["jev-latest"]);
    expect(parseModelIds(null)).toEqual([]);
  });
});

describe("findOpenIssue", () => {
  it("reads every page of open labelled issues, so a second run updates the same one", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 500 + i, title: "other" }));
    const page2 = [{ number: 42, title: FRESHNESS_ISSUE_TITLE }];
    const fetchImpl = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return new Response(JSON.stringify(page === 1 ? page1 : page === 2 ? page2 : []));
    });
    const found = await findOpenIssue("o/r", "t", fetchImpl as never);
    expect(found?.number).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the oldest when duplicates already exist", async () => {
    const issues = [{ number: 9, title: FRESHNESS_ISSUE_TITLE }, { number: 3, title: FRESHNESS_ISSUE_TITLE }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(issues)));
    expect((await findOpenIssue("o/r", "t", fetchImpl as never))?.number).toBe(3);
  });
});

describe("the workflow and script", () => {
  const workflow = readFileSync(".github/workflows/model-freshness.yml", "utf8");
  const script = readFileSync("scripts/model-freshness.ts", "utf8");

  it("lists Jev's models too, with the key from a repo secret", () => {
    expect(workflow).toContain("TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}");
    expect(script).toContain("api.typesafe.ai/v1/models");
  });

  it("never puts a key in a URL, and never runs two checks at once", () => {
    expect(script).not.toMatch(/[?&]key=/);
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: model-freshness/);
  });
});
