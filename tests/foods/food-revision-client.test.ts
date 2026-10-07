/**
 * sol BLOCK (review round 2, finding #4 follow-up): `currentRevisionAndIdentityFor` reads the
 * revision a food ref resolves to RIGHT NOW — the catalog food's active revision, or a user
 * food's own `rev` — and the product identity behind it, through the same tables
 * lib/server/allergen-evidence.ts markLabelChecked itself resolves against when it accepts an
 * `expectedRevisions` entry (food_refs, catalog_food_revisions, user_foods; all readable under
 * RLS, see supabase/migrations/20260911000500_rls.sql). It is the Foods sheet's own way of
 * learning "the revision and product I am about to bind this check to" — the barcode card
 * already has one on the match it displays (components/coach/editors/AllergenCheck.tsx), and the
 * Foods sheet has nothing on screen to read either off at all.
 *
 * review round 2 (sol BLOCK): this replaces the earlier two-function shape (`currentRevisionFor`
 * + `currentProductIdentityFor`, raced together by the caller's own Promise.all) with ONE read per
 * branch, so the revision id and its identity always come from the same row of the same query and
 * can never disagree about which product is current.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { currentRevisionAndIdentityFor } from "@/lib/foods/food-revision-client";

type Row = Record<string, unknown>;

function clientWith(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return chain; },
      maybeSingle: async () => ({
        data: (tables[table] ?? []).find((row) => filters.every((pick) => pick(row))) ?? null,
        error: null,
      }),
    };
    return chain;
  };
  return { from } as never;
}

beforeEach(() => { bindAccount("user-a"); });
afterEach(() => { unbindAccount(); });

describe("currentRevisionAndIdentityFor", () => {
  it("resolves a catalog ref to its active revision's id, description and brand — one row, one " +
    "read", async () => {
    const client = clientWith({
      food_refs: [{ id: "ref-1", kind: "catalog", catalog_food_id: 12, user_food_id: null }],
      catalog_food_revisions: [
        { id: 410, catalog_food_id: 12, is_active: true, description: "Trail mix", brand: "Acme" },
      ],
    });
    expect(await currentRevisionAndIdentityFor("ref-1", client))
      .toEqual({ revisionId: 410, identity: { description: "Trail mix", brand: "Acme" } });
  });

  it("resolves a user ref to the user food's own rev, name and brand", async () => {
    const client = clientWith({
      food_refs: [{ id: "ref-2", kind: "user", catalog_food_id: null, user_food_id: "food-9" }],
      user_foods: [{ id: "food-9", rev: 3, name: "Grandma's trail mix", brand: null }],
    });
    expect(await currentRevisionAndIdentityFor("ref-2", client))
      .toEqual({ revisionId: 3, identity: { description: "Grandma's trail mix", brand: null } });
  });

  it("returns null when the ref does not exist", async () => {
    const client = clientWith({ food_refs: [] });
    expect(await currentRevisionAndIdentityFor("missing", client)).toBeNull();
  });

  it("returns null when a catalog food has no active revision", async () => {
    const client = clientWith({
      food_refs: [{ id: "ref-3", kind: "catalog", catalog_food_id: 5, user_food_id: null }],
      catalog_food_revisions: [],
    });
    expect(await currentRevisionAndIdentityFor("ref-3", client)).toBeNull();
  });

  it("returns null when a user food ref names no row", async () => {
    const client = clientWith({
      food_refs: [{ id: "ref-4", kind: "user", catalog_food_id: null, user_food_id: "gone" }],
      user_foods: [],
    });
    expect(await currentRevisionAndIdentityFor("ref-4", client)).toBeNull();
  });
});
