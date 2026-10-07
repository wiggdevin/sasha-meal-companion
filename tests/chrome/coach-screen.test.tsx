// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CoachScreen from "@/app/coach/CoachScreen";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";

const navigation = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

vi.mock("@/components/CoachChat", () => ({
  default: () => {
    throw new Error("CoachChat must not mount while the capability is off");
  },
}));

beforeEach(() => {
  sessionStorage.clear();
  navigation.back.mockReset();
  navigation.push.mockReset();
  navigation.replace.mockReset();
});

afterEach(cleanup);

function renderCoach(): void {
  render(
    <CapabilitiesProvider value={{ coach: false, scan: false, captureMethods: [] }}>
      <CoachScreen />
    </CapabilitiesProvider>,
  );
}

it("shows the unavailable state without mounting chat when coach is off", () => {
  renderCoach();
  expect(screen.getByRole("heading", { name: "Sasha" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Sasha is unavailable right now");
  expect(screen.queryByText("Loading your conversation…")).toBeNull();
});
