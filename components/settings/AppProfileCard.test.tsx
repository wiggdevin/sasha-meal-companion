// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/lib/store";
import AppProfileCard from "./AppProfileCard";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({ auth: { getSession: mocks.getSession } }),
}));

vi.mock("@/components/Onboarding/OnboardingFlow", () => ({
  default: ({ onFinished }: { onFinished?: () => void }) => (
    <div>
      Profile editor
      <button type="button" onClick={onFinished}>Finish editor</button>
    </div>
  ),
}));

beforeEach(() => {
  mocks.getSession.mockResolvedValue({
    data: { session: { user: { email: "devs@example.com" } } },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings app profile card", () => {
  it("shows the plan ready state with the signed-in account and authoritative targets", async () => {
    const settings = {
      ...defaultSettings(),
      sex: "male" as const,
      birthYear: 1990,
      heightCm: 180,
      weightKg: 80,
      activityLevel: "moderate" as const,
      goal: "recomp" as const,
      mealsPerDay: 4,
    };

    render(<AppProfileCard settings={settings} setup={false}
      training={{ kcal: 2150, protein: 150, carbs: 235, fat: 68 }}
      rest={{ kcal: 1980, protein: 150, carbs: 195, fat: 67 }} />);

    expect(await screen.findByText("devs@example.com")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeTruthy();
    expect(screen.getByLabelText("Profile ready").textContent).toContain("D");
    expect(screen.getByText("Plan ready")).toBeTruthy();
    expect(screen.getByText("Recomposition")).toBeTruthy();
    expect(screen.getByText("4 meals")).toBeTruthy();
    expect(screen.getByText("2,150")).toBeTruthy();
    expect(screen.getByText("1,980")).toBeTruthy();
    expect(screen.getByText("150")).toBeTruthy();
    expect(screen.getByText("Training day")).toBeTruthy();
  });

  it("opens the existing profile flow from the setup needed state", async () => {
    render(<AppProfileCard settings={defaultSettings()} setup
      training={null} rest={null} />);

    await screen.findByText("devs@example.com");
    expect(screen.getByText("Setup needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish profile" }));
    expect(screen.getByText("Profile editor")).toBeTruthy();
  });

  it("does not claim the plan is ready in the targets unavailable state", async () => {
    const settings = {
      ...defaultSettings(),
      sex: "male" as const,
      birthYear: 1990,
      heightCm: 180,
      weightKg: 80,
      activityLevel: "moderate" as const,
      goal: "recomp" as const,
    };

    render(<AppProfileCard settings={settings} setup={false} training={null} rest={null} />);

    await screen.findByText("devs@example.com");
    expect(screen.getByText("Targets unavailable")).toBeTruthy();
    expect(screen.queryByText("Plan ready")).toBeNull();
  });
});
