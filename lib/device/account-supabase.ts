/**
 * Direct Supabase calls from the client (Phase 9 §0.5a; audit plan r3 finding 3).
 *
 * `browserClient()` uses the session cookie every tab of this origin shares, so a call that A
 * started can run under B's JWT. Two defences, both here:
 *  - the owner goes INTO the call (`p_user` / `p_user_id` / `row.user_id` = the handle's id), so
 *    the database refuses a write under another account's session (`_sync_assert_caller`, RLS);
 *  - the handle is checked before the call and after it resolves, so a read that answers after a
 *    switch is dropped.
 */
import { assertCurrent, type AccountHandle } from "./account";

/** Run one direct Supabase call for the account that started the work. */
export async function withAccount<T>(
  h: AccountHandle, run: (userId: string) => PromiseLike<T>,
): Promise<T> {
  assertCurrent(h);
  const result = await run(h.userId);
  assertCurrent(h);
  return result;
}
