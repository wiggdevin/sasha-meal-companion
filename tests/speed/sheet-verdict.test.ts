/**
 * One verdict, read the same way by all three confirm sheets (Grok pass 11, HIGH 1).
 *
 * The capture sheet and the scan sheet each decided success by naming statuses — `ok` or `queued`
 * — so a 2xx whose body could not be read (`accepted`) and a conflict that handed back the entity
 * were treated as failures: the sheet showed "Logged…" as an error, kept the draft open, and the
 * next Save minted a second entry_id. Two meals in her log for one tap.
 *
 * `outcomeFor` already knew the answer in both cases. `savedFrom` is that answer in the shape a
 * sheet needs, and the source checks below are what keep the sheets from deciding it again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outcomeFor, savedFrom } from "@/lib/log/outcome";
import type { CommitResult } from "@/lib/log-commit-client";

const ENTITY = { id: "aaaaaaaa-1111-4111-8111-111111111111", rev: 4, items: [] };

function sheet(name: string): string {
  return readFileSync(new URL(`../../components/${name}`, import.meta.url), "utf8");
}

describe("what counts as saved", () => {
  it.each([
    ["a 2xx the client could not read", { status: "accepted" } as CommitResult],
    ["a conflict that hands back the entry", {
      status: "conflict", current_rev: 4, entity: ENTITY } as unknown as CommitResult],
    ["a queued write", { status: "queued" } as CommitResult],
  ])("closes the sheet for %s", (_name, result) => {
    expect(outcomeFor(result).keep).toBe(true);
    expect(savedFrom(result).ok).toBe(true);
  });

  it.each([
    ["a named refusal", { status: "invalid", issues: [] } as unknown as CommitResult],
    ["an entry another tab owns", { status: "owned_elsewhere" } as CommitResult],
  ])("keeps the sheet open for %s, with the reason", (_name, result) => {
    const saved = savedFrom(result);
    expect(saved.ok).toBe(false);
    expect(saved.ok === false && saved.message.length > 0).toBe(true);
  });

  it("says a food was updated in the words that path has always used", () => {
    const stale = savedFrom({ status: "stale_revision" } as unknown as CommitResult);
    expect(stale.ok === false && stale.message).toBe("That food was updated. Log it from search.");
  });
});

describe("the sheets", () => {
  it.each(["CaptureSheet.tsx", "ScanConfirmSheet.tsx"])(
    "%s decides from the verdict, not from a list of statuses", (name) => {
      const source = sheet(name);
      expect(source).toMatch(/savedFrom|outcomeFor/);
      // The two status lists that used to stand in for the verdict.
      expect(source).not.toMatch(/status === "ok" \|\| result\.status === "queued"/);
      expect(source).not.toMatch(/status !== "ok" && result\.status !== "queued"/);
    });
});
