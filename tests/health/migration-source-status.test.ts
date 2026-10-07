/** [needs local Docker] — proves security-invoker ownership and both migration directions. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestUsers, HAS_DB, runSql } from "../helpers/supabase";

const UP = "supabase/migrations/20261024093100_health_source_status.sql";
const DOWN = "supabase/migrations/down/20261024093100_health_source_status.down.sql";

describe.skipIf(!HAS_DB)("20261024093100_health_source_status", () => {
  it("returns every owned source's own receipt and denies cross-user rows", async () => {
    const { a, b } = await createTestUsers();
    const up = readFileSync(UP, "utf8");
    const down = readFileSync(DOWN, "utf8");
    const output = runSql(`
      begin;
      ${down}
      ${up}
      insert into health_sources (id, user_id, kind, device_label) values
        ('a9310000-0000-4000-8000-000000000001', '${a.userId}', 'health_auto_export', 'noisy-source'),
        ('a9310000-0000-4000-8000-000000000002', '${a.userId}', 'apple_health_shortcut', 'older-source'),
        ('a9310000-0000-4000-8000-000000000003', '${b.userId}', 'apple_health_shortcut', 'other-user');
      insert into ingest_events (user_id, source_id, status, payload_hash, received_at)
        values
          ('${a.userId}', 'a9310000-0000-4000-8000-000000000001', 'applied', decode(md5('noisy-1'), 'hex'), '2026-09-20T12:00:00Z'),
          ('${a.userId}', 'a9310000-0000-4000-8000-000000000001', 'applied', decode(md5('noisy-2'), 'hex'), '2026-09-20T12:01:00Z'),
          ('${a.userId}', 'a9310000-0000-4000-8000-000000000002', 'applied', decode(md5('older'), 'hex'), '2026-09-10T12:00:00Z'),
          ('${b.userId}', 'a9310000-0000-4000-8000-000000000003', 'applied', decode(md5('other'), 'hex'), '2026-09-20T12:02:00Z');
      select set_config('request.jwt.claim.sub', '${a.userId}', true);
      set local role authenticated;
      select 'own:' || count(*) from health_source_status where id in (
        'a9310000-0000-4000-8000-000000000001',
        'a9310000-0000-4000-8000-000000000002'
      );
      select 'older:' || last_received_at from health_source_status
        where id = 'a9310000-0000-4000-8000-000000000002';
      select 'cross:' || count(*) from health_source_status where user_id = '${b.userId}';
      reset role;
      select 'invoker:' || coalesce(array_position(reloptions, 'security_invoker=true')::text, '0')
        from pg_class where oid = 'health_source_status'::regclass;
      ${down}
      select 'down:' || count(*) from pg_views
        where schemaname = 'public' and viewname = 'health_source_status';
      rollback;
    `).split("\n");
    expect(output.join("|")).toContain("own:2");
    expect(output.some((line) => line.startsWith("older:2026-09-10 12:00:00"))).toBe(true);
    expect(output).toContain("cross:0");
    expect(output).toContain("invoker:1");
    expect(output).toContain("down:0");
  });
});
