import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { psqlEnv } from "./helpers";

describe("catalog psql helper", () => {
  it("passes the database URL through libpq environment variables", () => {
    const env = psqlEnv("postgresql://postgres:s%40cret@db.local:54322/postgres?sslmode=disable", {});
    expect(env).toMatchObject({
      PGHOST: "db.local",
      PGPORT: "54322",
      PGUSER: "postgres",
      PGPASSWORD: "s@cret",
      PGDATABASE: "postgres",
      PGSSLMODE: "disable",
    });
  });

  it("never puts the URL in the psql argument list", () => {
    const source = readFileSync(new URL("./helpers.ts", import.meta.url), "utf8");
    const call = source.match(/execFileSync\("psql", \[([^\]]*)\]/)?.[1] ?? "";
    expect(call).not.toContain("BRANCH_DB_URL");
  });
});
