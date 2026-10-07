import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { loadEligibleLocalFoodIds } from "./eligible-client";

afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

describe("food eligibility request", () => {
  it("gives pending historical rule review an actionable message", async () => {
    const account = bindAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "rule_review_required",
      message: "Review your existing food rules." }, { status: 409 })));
    await expect(loadEligibleLocalFoodIds(account, {}))
      .rejects.toThrow("Review your existing food rules in Settings before swapping meals.");
  });
});
