/**
 * sol finding: a failed pre-write read inside `recordAllergenEvidence` must never fall back to
 * "nothing stored" and write over it — the module's own header says a failed READ degrades to
 * no-evidence for a READER, but doing the same thing before a WRITE lets a transient error (or a
 * concurrent warmer's read landing between two writes) silently downgrade a previously-recorded
 * `listed` row to whatever this run's fresh, lower-confidence derivation says. `recordAllergenEvidence`
 * must skip the write for that batch instead of guessing.
 */
import { describe, expect, it, vi } from "vitest";
import { recordAllergenEvidence } from "@/lib/server/allergen-evidence";

function writerWithFailingRead() {
  const rows: unknown[] = [];
  const upsert = vi.fn(async (value: unknown) => { rows.push(...(value as unknown[])); return { error: null }; });
  const from = (_table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, in: () => chain, order: () => chain, range: () => chain,
      then: (resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) =>
        Promise.resolve({ data: null, error: { message: "read timed out" } }).then(resolve),
      upsert,
    });
    return chain;
  };
  return { client: { from } as never, rows, upsert };
}

// A complete, dairy-free list: the fresh derivation alone would write dairy as not_listed —
// exactly what must never overwrite a stored `listed` this run could not actually see.
const FOOD = { foodKey: "k1", userId: null, ingredientsText: "Water, sugar, salt.", labelComplete: true };

describe("recordAllergenEvidence: a failed pre-write read never becomes a write", () => {
  it("writes nothing and reports every food as an error, rather than writing the fresh " +
    "derivation over evidence it could not read", async () => {
      const { client, rows, upsert } = writerWithFailingRead();
      const result = await recordAllergenEvidence(client, [FOOD]);
      expect(upsert).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
      expect(result).toEqual({ written: 0, errors: 1, withEvidence: 0 });
    });

  it("counts every food in the failed batch as an error, not just the first", async () => {
    const { client, upsert } = writerWithFailingRead();
    const result = await recordAllergenEvidence(client,
      [FOOD, { ...FOOD, foodKey: "k2" }, { ...FOOD, foodKey: "k3" }]);
    expect(upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ written: 0, errors: 3, withEvidence: 0 });
  });
});
