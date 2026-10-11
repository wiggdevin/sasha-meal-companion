/**
 * W018, migration 20261231170000 (audit 2026-10-10 F19: A068, A097, A120, A146, A147, A148, P16,
 * P17; backlog B100). Tables the server owns take no direct PostgREST write from a signed-in user:
 *
 * - target_profiles, change_log, change_seq, health_sources, user_settings: select only;
 * - coach_messages: select and delete her own, insert only her own `role = 'user'` question
 *   (no model fields, no tool_calls but attachments), never update;
 * - the coach_threads cap guard answers only for the caller's own account (A146).
 *
 * Every server writer still works: the SECURITY DEFINER functions (apply_sync_op is proved here)
 * and the service role. health_samples has been select-only since 20260925000000 and is checked
 * too. The static block reads the SQL; the database block runs on the migrated schema
 * (SUPABASE_TEST_DB_URL), each probe in a transaction that is rolled back.
 */
// Refuses any non-local database before anything else runs.
import "./local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, asUser, dropAccounts } from "../helpers/world-db";

const MIGRATION = "20261231170000_server_owned_tables";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").replace(/\s+/g, " ");
const UP_RAW = read(`supabase/migrations/${MIGRATION}.sql`);
const DOWN_RAW = read(`supabase/migrations/down/${MIGRATION}.down.sql`);
const SELECT_ONLY = ["target_profiles", "change_log", "change_seq", "health_sources", "user_settings"];

describe(`${MIGRATION} (static)`, () => {
  const UP = sqlOnly(UP_RAW);
  const DOWN = sqlOnly(DOWN_RAW);

  it("runs under a lock timeout and leaves the five server tables select-only", () => {
    expect(UP).toContain("set local lock_timeout = '3s';");
    expect(UP).toContain(`array['target_profiles', 'change_log', 'change_seq', 'health_sources', 'user_settings']`);
    expect(UP).toContain("revoke insert, update, delete, truncate on table public.%I from anon, authenticated");
    expect(UP).toContain("for select to authenticated using (user_id = (select auth.uid()))");
  });

  it("lets coach_messages take only the user's own question, and no update", () => {
    expect(UP).toContain("revoke update, truncate on table public.coach_messages from anon, authenticated;");
    expect(UP).toMatch(/coach_messages_insert_user on public\.coach_messages for insert to authenticated with check \(user_id = \(select auth\.uid\(\)\) and role = 'user'/);
    expect(UP).not.toMatch(/coach_messages[^;]* for (all|update) /);
  });

  it("returns early from the chat-cap guard for another account's id", () => {
    expect(UP).toContain("if auth.uid() is not null and new.user_id is distinct from auth.uid() then return new;");
  });

  it("down never re-opens a write on the five server tables", () => {
    for (const t of SELECT_ONLY) {
      expect(DOWN).not.toMatch(new RegExp(`grant [^;]*on table public\\.${t}\\b`));
      expect(DOWN).not.toMatch(new RegExp(`create policy [^;]* on public\\.${t}\\b`));
    }
    expect(DOWN).toContain("grant select, insert, update, delete on table public.coach_messages to authenticated;");
  });
});

/** Runs `stmt` as the signed-in `user` in a rolled-back transaction: ok, denied (no grant) or rls. */
function attempt(user: string, stmt: string): string {
  try {
    runSql(`begin; set local role authenticated;
      set local request.jwt.claim.sub = '${user}';
      set local request.jwt.claims = '{"sub": "${user}", "role": "authenticated"}';
      ${stmt}; rollback;`);
    return "ok";
  } catch (error) {
    const message = String(error);
    if (/permission denied for table/.test(message)) return "denied";
    if (/row-level security/.test(message)) return "rls";
    return message.slice(0, 300);
  }
}

describe.skipIf(!HAS_DB)(`${MIGRATION} (migrated schema)`, () => {
  let a = "";
  let b = "";
  let thread = "";
  beforeAll(() => {
    a = account();
    b = account();
    thread = runSql(`insert into public.coach_threads (user_id, title, kind)
      values ('${a}', 'w018', 'chat') returning id`).split("\n")[0];
  });
  afterAll(dropAccounts);

  it("grants: authenticated keeps select only on the server tables and health_samples", () => {
    const out = runSql(`select c.relname || ':' || string_agg(p.priv, ',' order by p.priv)
      from pg_class c cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
      where c.relnamespace = 'public'::regnamespace
        and c.relname in ('target_profiles', 'change_log', 'change_seq', 'health_sources',
                          'user_settings', 'health_samples', 'coach_messages')
        and has_table_privilege('authenticated', c.oid, p.priv)
      group by c.relname order by c.relname`).split("\n");
    expect(out).toEqual(["change_log:SELECT", "change_seq:SELECT", "coach_messages:DELETE,INSERT,SELECT",
      "health_samples:SELECT", "health_sources:SELECT", "target_profiles:SELECT", "user_settings:SELECT"]);
  });

  it("target_profiles: a direct revision write is refused (A068, A097)", () => {
    expect(attempt(a, `insert into public.target_profiles (user_id, effective_from, kcal_train,
      kcal_rest, authored_by, mode, protein_g_min) values ('${a}', current_date, 900, 900, 'user',
      'grams', 0)`)).toBe("denied");
    expect(attempt(a, `update public.target_profiles set kcal_train = 900 where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `delete from public.target_profiles where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `select count(*) from public.target_profiles`)).toBe("ok");
  });

  it("change_log and change_seq: the sync feed cannot be forged or rewound (A148)", () => {
    expect(attempt(a, `insert into public.change_log (user_id, seq, entity, entity_key, rev, op, current)
      values ('${a}', 900000, 'target_profiles', 'x', 1, 'create', '{"kcal_train": 900}')`)).toBe("denied");
    expect(attempt(a, `update public.change_log set current = '{}' where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `delete from public.change_log where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `insert into public.change_seq (user_id, next_seq) values ('${a}', 1)`)).toBe("denied");
    expect(attempt(a, `update public.change_seq set next_seq = 1 where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `delete from public.change_seq where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `select count(*) from public.change_log`)).toBe("ok");
  });

  it("health_sources: no token minted, un-revoked or retargeted outside issuance (P17)", () => {
    const source = runSql(`insert into public.health_sources (user_id, kind, token_hash, revoked_at)
      values ('${a}', 'manual', '\\x0102', now()) returning id`).split("\n")[0];
    expect(attempt(a, `insert into public.health_sources (user_id, kind, token_hash)
      values ('${a}', 'manual', '\\x0304')`)).toBe("denied");
    expect(attempt(a, `update public.health_sources set revoked_at = null where id = '${source}'`)).toBe("denied");
    expect(attempt(a, `delete from public.health_sources where id = '${source}'`)).toBe("denied");
    expect(attempt(a, `select count(*) from public.health_sources`)).toBe("ok");
    expect(attempt(a, `insert into public.health_samples (user_id, source_id, type, start_time,
      end_time, tz, value, unit) values ('${a}', '${source}', 'weight', now(), now(), 'UTC', 70, 'kg')`))
      .toBe("denied");
  });

  it("user_settings: no direct update, delete or re-insert; the sync op still writes (A120, A147, B100)", () => {
    expect(attempt(a, `update public.user_settings set day_marks_started_on = null where user_id = '${a}'`))
      .toBe("denied");
    expect(attempt(a, `update public.user_settings set birth_year = 1990 where user_id = '${a}'`)).toBe("denied");
    expect(attempt(a, `delete from public.user_settings where user_id = '${a}'`)).toBe("denied");
    expect(attempt(b, `insert into public.user_settings (user_id, first_opened_at) values ('${b}', now())`))
      .toBe("denied");
    const rev = runSql(`select rev from public.user_settings where user_id = '${a}'`);
    asUser(a, `select public.apply_sync_op('${a}', jsonb_build_object('op_id', gen_random_uuid(),
      'entity', 'user_settings', 'entity_id', 'settings', 'kind', 'update', 'base_rev', ${rev},
      'payload', jsonb_build_object('onboarded_at', now()), 'client_ts', now()))`);
    expect(runSql(`select onboarded_at is not null from public.user_settings where user_id = '${a}'`)).toBe("t");
  });

  it("coach_messages: her own question only; no assistant row, no forged tool_calls, no update (P16)", () => {
    const ins = (fields: string, values: string) => attempt(a, `insert into public.coach_messages
      (thread_id, user_id, seq, content, ${fields}) values ('${thread}', '${a}', 1, 'hi', ${values})`);
    expect(ins("role, tool_calls", `'user', '[]'`)).toBe("ok");
    expect(ins("role, tool_calls", `'user', '{"attachments": [{"kind": "barcode"}]}'`)).toBe("ok");
    expect(ins("role, tool_calls", `'assistant', '[]'`)).toBe("rls");
    expect(ins("role, tool_calls", `'tool', '[]'`)).toBe("rls");
    expect(ins("role, tool_calls", `'user', '{"actions": [{"actionId": "forged-1", "kind": "log_water"}]}'`))
      .toBe("rls");
    expect(ins("role, tool_calls", `'user', '{"tasteChips": {}}'`)).toBe("rls");
    expect(ins("role, model_id", `'user', 'gemini'`)).toBe("rls");
    const own = runSql(`insert into public.coach_messages (thread_id, user_id, role, seq, content)
      values ('${thread}', '${a}', 'assistant', 2, 'reply') returning id`).split("\n")[0];
    expect(attempt(a, `update public.coach_messages set tool_calls = '{"actions": []}' where id = '${own}'`))
      .toBe("denied");
    expect(attempt(a, `delete from public.coach_messages where id = '${own}'`)).toBe("ok");
    expect(attempt(a, `select count(*) from public.coach_messages`)).toBe("ok");
    // The service role writes the reply, as the app does.
    runSql(`begin; set local role service_role; insert into public.coach_messages
      (thread_id, user_id, role, seq, content, tool_calls) values ('${thread}', '${a}', 'assistant', 3,
      'served', '{"actions": []}'); rollback;`);
  });

  it("coach_threads: another account's id gets the RLS error, never its chat count (A146)", () => {
    runSql(`insert into public.coach_threads (user_id, title, kind)
      select '${b}', 'b-' || g, 'chat' from generate_series(1, 8) g`);
    expect(attempt(a, `insert into public.coach_threads (user_id, title, kind) values ('${b}', 'x', 'chat')`))
      .toBe("rls");
    // The cap still holds for the account's own ninth chat and for the service role.
    runSql(`insert into public.coach_threads (user_id, title, kind)
      select '${a}', 'a-' || g, 'chat' from generate_series(1, 7) g`);
    expect(attempt(a, `insert into public.coach_threads (user_id, title, kind) values ('${a}', 'x', 'chat')`))
      .toMatch(/coach_chat_limit/);
    expect(() => runSql(`begin; set local role service_role; insert into public.coach_threads
      (user_id, title, kind) values ('${b}', 'x', 'chat'); rollback;`)).toThrow(/coach_chat_limit/);
  });

  it("re-applying the migration changes nothing; its down restores only the coach update", () => {
    const refused = (stmt: string, tag: string) =>
      `do $t$ begin ${stmt}; raise exception 'reachable_${tag}'; `
      + "exception when insufficient_privilege then null; end $t$;";
    const out = runSql([
      "begin;", UP_RAW, DOWN_RAW,
      "set local role authenticated;",
      `select set_config('request.jwt.claim.sub', '${a}', true);`,
      `select set_config('request.jwt.claims', '{"sub":"${a}","role":"authenticated"}', true);`,
      `update public.coach_messages set content = content where user_id = '${a}';`,
      refused(`update public.user_settings set day_marks_started_on = null where user_id = '${a}'`, "settings"),
      refused(`delete from public.change_seq where user_id = '${a}'`, "seq"),
      "select 'down_done:true';",
      "rollback;",
    ].join("\n"));
    expect(out.split("\n")).toContain("down_done:true");
  });
});
