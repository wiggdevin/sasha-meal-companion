// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { localIsoDate, pageForPath, scopeForLocation, scopeLabel } from "@/components/dock/chat-scope";
import { inertOutside } from "@/components/dock/inert-outside";

describe("the dock ask's scope", () => {
  it("is page-bound on each dock tab and global on /coach", () => {
    expect(scopeForLocation("/foods", "", "2026-10-04")).toEqual({ kind: "page", page: "foods" });
    expect(scopeForLocation("/body", "?x=1", "2026-10-04")).toEqual({ kind: "page", page: "body" });
    expect(scopeForLocation("/settings", "", "2026-10-04")).toEqual({ kind: "page", page: "settings" });
    expect(scopeForLocation("/coach", "", "2026-10-04")).toEqual({ kind: "global" });
    expect(scopeForLocation("/recipes", "", "2026-10-04")).toEqual({ kind: "global" });
  });

  it("names the day Today is showing, else today's date", () => {
    expect(scopeForLocation("/", "?d=2026-10-02", "2026-10-04"))
      .toEqual({ kind: "page", page: "today", date: "2026-10-02" });
    expect(scopeForLocation("/", "", "2026-10-04")).toEqual({ kind: "page", page: "today", date: "2026-10-04" });
    expect(scopeForLocation("/", "?d=2026-02-30", "2026-10-04"))
      .toEqual({ kind: "page", page: "today", date: "2026-10-04" });
  });

  it("counts a sub-path as its tab", () => {
    expect(pageForPath("/foods/123")).toBe("foods");
    expect(pageForPath("/foodstuff")).toBeNull();
  });

  it("labels the header chip", () => {
    expect(scopeLabel({ kind: "page", page: "today", date: "2026-10-04" })).toBe("On Today");
    expect(scopeLabel({ kind: "global" })).toBe("Whole app");
  });

  it("formats the phone's local date", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("inertOutside", () => {
  it("makes the page inert but keeps the overlay and the dock live, then restores", () => {
    document.body.innerHTML = `<div id="page"><main id="main"></main></div><div id="already" inert></div>
      <div id="wrap"><div id="overlay"></div><span id="sibling"></span></div><nav id="dock"></nav>`;
    const byId = (id: string) => document.getElementById(id)!;
    const release = inertOutside([byId("overlay"), byId("dock")]);
    expect(byId("page").hasAttribute("inert")).toBe(true);
    expect(byId("sibling").hasAttribute("inert")).toBe(true);
    expect(byId("wrap").hasAttribute("inert")).toBe(false);
    expect(byId("overlay").hasAttribute("inert")).toBe(false);
    expect(byId("dock").hasAttribute("inert")).toBe(false);
    release();
    expect(byId("page").hasAttribute("inert")).toBe(false);
    expect(byId("sibling").hasAttribute("inert")).toBe(false);
    expect(byId("already").hasAttribute("inert")).toBe(true);
  });
});
