/**
 * Loop 010, 2026-09-14: opening any existing coach thread answered 500 "Could not read the
 * transcript." The route defaulted `before` to Number.MAX_SAFE_INTEGER and passed it straight into
 * `.lt("seq", ...)`, but `coach_messages.seq` is int4 — 9007199254740991 is out of range for the
 * comparison, so Postgres refused the query.
 *
 * It was invisible to every earlier check because a brand-new thread has no messages to page, and
 * an explicit `?before=` small enough to fit int4 returns 200. The failing call is the one the
 * client actually makes: lib/coach-client.ts sends no `before` when CoachChat opens a thread.
 */
import { describe, expect, it } from "vitest";
import { seqCeiling } from "@/lib/coach/thread-paging";

const INT4_MAX = 2_147_483_647;

describe("seqCeiling", () => {
  it("stays inside int4 when no before is given — the default client call", () => {
    expect(seqCeiling(null)).toBe(INT4_MAX);
    expect(seqCeiling(null)).toBeLessThanOrEqual(INT4_MAX);
  });

  it("passes a real cursor through untouched", () => {
    expect(seqCeiling("100")).toBe(100);
    expect(seqCeiling("1")).toBe(1);
  });

  it("clamps a cursor past int4 instead of handing Postgres an out-of-range value", () => {
    expect(seqCeiling(String(INT4_MAX + 1))).toBe(INT4_MAX);
    expect(seqCeiling(String(Number.MAX_SAFE_INTEGER))).toBe(INT4_MAX);
  });

  it("falls back to the ceiling for values that are not a usable cursor", () => {
    expect(seqCeiling("not-a-number")).toBe(INT4_MAX);
    expect(seqCeiling("")).toBe(INT4_MAX);
    expect(seqCeiling("Infinity")).toBe(INT4_MAX);
  });

  it("never returns a negative or zero ceiling, which would hide every message", () => {
    expect(seqCeiling("-5")).toBe(INT4_MAX);
    expect(seqCeiling("0")).toBe(INT4_MAX);
  });
});
