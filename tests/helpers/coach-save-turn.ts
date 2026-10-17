/**
 * `coach_save_turn` (W088, migration 20270104120000) played against a test's own fake tables: the
 * thread insert, one coach_messages insert per row at consecutive seqs, a seq conflict saved again
 * after the thread's last seq, and the thread touch, all through the fake's `from`. Fakes that
 * record coach rows keep recording them as before. The SQL itself is proven on a real Postgres by
 * tests/migrations/coach-save-turn-db.test.ts.
 */

type Result = { data?: unknown; error: { code?: string; message?: string; details?: string } | null };
/** A fake's query builder: every method chains, and awaiting it answers the query. */
type Builder = { [method: string]: (...args: unknown[]) => Builder } & PromiseLike<Result>;
type Fake = { from: (table: string) => Builder;
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<unknown> };

async function saveTurn(admin: Fake, args: Record<string, unknown>): Promise<Result> {
  const threadId = args.p_thread_id as string;
  if (args.p_new_title !== null) {
    const { error } = await admin.from("coach_threads").insert({
      id: threadId, user_id: args.p_user_id, title: args.p_new_title, kind: args.p_kind,
    }) as Result;
    if (error) return { data: null, error };
  }
  let rows = args.p_rows as { id: string; seq: number }[];
  for (let attempt = 1; ; attempt += 1) {
    const landed: string[] = [];
    let conflict = false;
    for (const row of rows) {
      const { error } = await admin.from("coach_messages").insert(row) as Result;
      const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
      if (error?.code === "23505" && text.includes("coach_messages_thread_seq")) {
        conflict = true;
        break;
      }
      if (error?.code === "23505") {
        return { data: null, error: { code: "P0001", message: "coach_message_exists" } };
      }
      if (error) return { data: null, error };
      landed.push(row.id);
    }
    if (!conflict) break;
    // The transaction rolls back: rows of this attempt that landed are not kept.
    if (landed.length > 0) await admin.from("coach_messages").delete().in("id", landed);
    if (attempt >= 3) return { data: null, error: { code: "P0001", message: "coach_seq_busy" } };
    const { data } = await admin.from("coach_messages").select("seq").eq("thread_id", threadId)
      .order("seq", { ascending: false }).limit(1).maybeSingle() as Result;
    const first = ((data as { seq: number } | null)?.seq ?? 0) + 1;
    rows = rows.map((row, i) => ({ ...row, seq: first + i }));
  }
  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (args.p_summary !== null) patch.summary = args.p_summary;
  await admin.from("coach_threads").update(patch).eq("id", threadId);
  return { data: rows.map((row) => ({ id: row.id, seq: row.seq })), error: null };
}

/** The fake admin client with `coach_save_turn` answered; every other rpc goes to its own. */
export function withCoachSaveTurn<T>(admin: T): T {
  const fake = admin as unknown as Fake;
  if (!fake || typeof fake.from !== "function") return admin;
  const own = fake.rpc?.bind(fake);
  return Object.assign(Object.create(Object.getPrototypeOf(fake)), fake, {
    rpc: (fn: string, args: Record<string, unknown>) => fn === "coach_save_turn"
      ? saveTurn(fake, args)
      : own ? own(fn, args) : Promise.resolve({ data: null, error: null }),
  }) as T;
}
