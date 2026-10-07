import { describe, expect, it } from "vitest";
import { HAS_DB, sql } from "./fixtures";

const SIG = "public.catalog_search(text,text,text,integer)";

describe.skipIf(!HAS_DB)("catalog_search security", () => {
  it("exists exactly once with the contracts §2 signature", () => {
    expect(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'catalog_search'`)
    ).toBe("1");
    expect(sql(`select pg_get_function_identity_arguments('${SIG}'::regprocedure)`)).toBe(
      "p_q text, p_brand text, p_prep text, p_limit integer"
    );
  });

  it("is security invoker, so RLS is the caller's", () => {
    expect(
      sql(`select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'catalog_search'`)
    ).toBe("f");
  });

  it("is executable by authenticated and by nobody anonymous", () => {
    expect(sql(`select has_function_privilege('authenticated', '${SIG}', 'execute')`)).toBe("t");
    expect(sql(`select has_function_privilege('anon', '${SIG}', 'execute')`)).toBe("f");
  });

  it("pins its search_path", () => {
    expect(
      sql(`select array_to_string(proconfig, ' ') from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'catalog_search'`)
    ).toContain("search_path=public, extensions, pg_temp");
  });
});
