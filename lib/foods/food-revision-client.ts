/**
 * Phase 13 §9 R1 (sol BLOCK, review round 2): the revision a food ref resolves to RIGHT NOW, and
 * the product identity behind it, read client-side through food_refs, catalog_food_revisions and
 * user_foods — all readable under RLS (supabase/migrations/20260911000500_rls.sql) — the same
 * tables lib/server/allergen-evidence.ts markLabelChecked itself resolves against when it accepts
 * an `expectedRevisions` entry.
 *
 * The barcode card already binds its "I checked the label" tap to the exact revision it displays
 * (components/coach/editors/AllergenCheck.tsx, `match.revisionId`). The Foods sheet has no label
 * or revision on screen to read one off at all, so this is the closest it can come: the revision
 * (and the product it names) current the moment its own check reads it, captured just before the
 * tap rather than left for the server to accept whatever happens to be active whenever the
 * request arrives.
 *
 * review round 2 (sol BLOCK): the revision id and its identity used to come from two SEPARATE
 * reads (`currentRevisionFor`, `currentProductIdentityFor`), raced together by the caller's own
 * Promise.all. Each one was its own round trip against "whichever revision is active right now" —
 * a background remap landing between the two requests completing could make them read DIFFERENT
 * rows: the revision id from one about to go stale, the identity from the one that just replaced
 * it (or the reverse). The Foods sheet would then show the account the NEW product's name while
 * binding the check to the OLD revision — the exact "exact product" mismatch §9 R1 exists to
 * prevent, and one the server's own `expectedRevisions` check cannot see, because both sides are
 * internally consistent, just not the same row. One function, one read per branch, below: the
 * revision id and its identity always come from the SAME row of the SAME query, so they can never
 * disagree about which product is current.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { browserClient } from "@/lib/supabase/client";

type FoodRefRow = {
  kind: "catalog" | "user"; catalog_food_id: number | null; user_food_id: string | null;
};

export type ProductIdentity = { description: string; brand: string | null };
export type CurrentRevision = { revisionId: number; identity: ProductIdentity };

export async function currentRevisionAndIdentityFor(
  foodRefId: string, supabase: SupabaseClient = browserClient(),
): Promise<CurrentRevision | null> {
  // Every read runs for the bound account (Phase 9 §0.5a); a switch mid-way throws AccountChanged.
  const h = accountHandle();
  const { data: refData } = await withAccount(h, () => supabase.from("food_refs")
    .select("kind, catalog_food_id, user_food_id").eq("id", foodRefId).maybeSingle());
  const ref = refData as FoodRefRow | null;
  if (!ref) return null;
  if (ref.kind === "catalog" && ref.catalog_food_id !== null) {
    const { data } = await withAccount(h, () => supabase.from("catalog_food_revisions")
      .select("id, description, brand")
      .eq("catalog_food_id", ref.catalog_food_id).eq("is_active", true).maybeSingle());
    const row = data as { id: number; description: string; brand: string | null } | null;
    return row ? { revisionId: row.id, identity: { description: row.description, brand: row.brand } }
      : null;
  }
  if (ref.kind === "user" && ref.user_food_id !== null) {
    const { data } = await withAccount(h, () => supabase.from("user_foods").select("rev, name, brand")
      .eq("id", ref.user_food_id).maybeSingle());
    const row = data as { rev: number; name: string; brand: string | null } | null;
    return row ? { revisionId: row.rev, identity: { description: row.name, brand: row.brand } } : null;
  }
  return null;
}
