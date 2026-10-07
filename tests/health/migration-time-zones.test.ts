/** [needs local Docker] — exercises both directions inside a rollback-only transaction. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestUsers, HAS_DB, runSql } from "../helpers/supabase";

const UP = "supabase/migrations/20261024093000_health_time_zones.sql";
const DOWN = "supabase/migrations/down/20261024093000_health_time_zones.down.sql";

describe.skipIf(!HAS_DB)("20261024093000_health_time_zones", () => {
  it("adds both nullable columns, enforces IANA source updates, and rolls down cleanly", async () => {
    const { a } = await createTestUsers();
    const up = readFileSync(UP, "utf8");
    const down = readFileSync(DOWN, "utf8");
    const output = runSql(`
      begin;
      ${down}
      ${up}
      insert into user_settings (user_id, first_opened_at, time_zone)
        values ('${a.userId}', now(), 'America/Chicago')
        on conflict (user_id) do update set time_zone = excluded.time_zone;
      insert into health_sources (id, user_id, kind, device_label)
        values ('a9300000-0000-4000-8000-000000000001', '${a.userId}',
          'apple_health_shortcut', 'migration-zone-test');
      select set_health_source_time_zone('${a.userId}',
        'a9300000-0000-4000-8000-000000000001', 'America/Denver');
      select 'up:' || count(*) from information_schema.columns
        where table_schema = 'public' and column_name = 'time_zone'
          and table_name in ('user_settings', 'health_sources');
      select 'source:' || time_zone from health_sources
        where id = 'a9300000-0000-4000-8000-000000000001';
      select 'context:' || source_time_zone || ':' || user_time_zone
        from health_ingest_time_zone_context('${a.userId}',
          'a9300000-0000-4000-8000-000000000001');
      do $$ begin
        begin
          perform set_health_source_time_zone('${a.userId}',
            'a9300000-0000-4000-8000-000000000001', 'Not/A_Time_Zone');
          raise exception 'invalid zone accepted';
        exception when sqlstate '22023' then null;
        end;
        begin
          update user_settings set time_zone = 'Not/A_Time_Zone' where user_id = '${a.userId}';
          raise exception 'invalid user zone accepted';
        exception when sqlstate '22023' then null;
        end;
      end $$;
      ${down}
      select 'down:' || count(*) from information_schema.columns
        where table_schema = 'public' and column_name = 'time_zone'
          and table_name in ('user_settings', 'health_sources');
      rollback;
    `).split("\n");
    expect(output).toContain("up:2");
    expect(output).toContain("source:America/Denver");
    expect(output).toContain("context:America/Denver:America/Chicago");
    expect(output).toContain("down:0");
  });
});
