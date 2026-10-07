import { describe, expect, it } from "vitest";
import { HAS_BRANCH, adminClient } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("views are security_invoker", () => {
  it("every view in public reports security_invoker=true", async () => {
    const { data, error } = await adminClient().rpc("test_view_options");
    expect(error).toBeNull();
    const views = (data ?? []) as { view_name: string; options: string[] }[];
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v.options, `${v.view_name} is not security_invoker`).toContain("security_invoker=true");
    }
  });

  it("weigh_ins is one of them", async () => {
    const { data } = await adminClient().rpc("test_view_options");
    const names = ((data ?? []) as { view_name: string }[]).map((v) => v.view_name);
    expect(names).toContain("weigh_ins");
  });
});
