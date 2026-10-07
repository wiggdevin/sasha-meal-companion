import { describe, expect, it } from "vitest";
import { freshnessLine, readFreshness } from "@/lib/dev/freshness";

describe("dev freshness", () => {
  it("reads the branch and how far it is behind origin/main", () => {
    const git = (args: string) => args.startsWith("rev-parse") ? "feat/x\n" : "21\n";
    expect(readFreshness(git)).toEqual({ branch: "feat/x", behind: 21 });
  });
  it("gives no answer when git fails", () => {
    expect(readFreshness(() => { throw new Error("no git"); })).toBeNull();
  });
  it("says nothing when current and names the gap when behind", () => {
    expect(freshnessLine({ branch: "main", behind: 0 })).toBeNull();
    expect(freshnessLine(null)).toBeNull();
    expect(freshnessLine({ branch: "feat/solid-onyx-ground", behind: 21 }))
      .toBe("Old code: feat/solid-onyx-ground is 21 commits behind main. Pull, or open the current checkout.");
  });
});
