// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { readGround } from "@/lib/design/ground-pref";
import BackgroundSection from "./BackgroundSection";

describe("Settings › Background", () => {
  let h: ReturnType<typeof bindAccount>;
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.ground;
    h = bindAccount("user-a");
  });
  afterEach(() => { cleanup(); unbindAccount(); });

  it("lists four grounds with Oat on", () => {
    render(<BackgroundSection />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Oat", "Sage", "Clay", "Mist"]);
    expect(screen.getByRole("radio", { name: "Oat" }).getAttribute("aria-checked")).toBe("true");
  });

  it("paints and keeps the choice for this account only", () => {
    render(<BackgroundSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Clay" }));
    expect(document.documentElement.dataset.ground).toBe("clay");
    expect(screen.getByRole("radio", { name: "Clay" }).getAttribute("aria-checked")).toBe("true");
    expect(readGround(h)).toBe("clay");
    unbindAccount();
    expect(readGround(bindAccount("user-b"))).toBe("oat");
  });
});
