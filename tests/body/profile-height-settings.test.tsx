// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BodyProfileFields from "@/components/BodyProfileFields";
import { defaultStore } from "@/lib/store";

const mocks = vi.hoisted(() => ({
  loadStore: vi.fn(),
  persistProfilePatch: vi.fn(),
  publishBodyProfile: vi.fn(),
  saveBodyProfile: vi.fn(),
}));

vi.mock("@/lib/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/store")>(),
  loadStore: mocks.loadStore,
}));

vi.mock("@/components/settings/use-settings-controller", () => ({
  persistProfilePatch: mocks.persistProfilePatch,
}));

vi.mock("@/lib/body-profile-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/body-profile-client")>(),
  publishBodyProfile: mocks.publishBodyProfile,
  saveBodyProfile: mocks.saveBodyProfile,
}));

vi.mock("@/lib/body-profile-fields", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/body-profile-fields")>(),
  useBodyProfileFields: () => ({
    drafts: { heightCm: "165.1", birthYear: "1996", bodyFatPct: "25", sex: "female" },
    draftErrors: {}, error: null, onEdit: vi.fn(), onCommit: vi.fn(), onSex: vi.fn(),
    onFocus: vi.fn(), onRetry: vi.fn(),
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  const store = defaultStore();
  store.settings.heightCm = 165.1;
  store.settings.heightUnit = "cm";
  mocks.loadStore.mockReturnValue(store);
  mocks.persistProfilePatch.mockResolvedValue(store);
});

describe("BodyProfileFields height settings", () => {
  it("persists height and its display unit through the Settings profile path", async () => {
    render(<BodyProfileFields />);

    const height = screen.getByLabelText("Height in centimetres");
    fireEvent.change(height, { target: { value: "170" } });
    expect(mocks.persistProfilePatch).not.toHaveBeenCalled();
    fireEvent.blur(height);
    fireEvent.click(screen.getByRole("button", { name: "Feet and inches" }));

    await waitFor(() => expect(mocks.persistProfilePatch).toHaveBeenCalledTimes(2));
    expect(mocks.persistProfilePatch.mock.calls.map((call) => call[1])).toEqual([
      { heightCm: 170 },
      { heightUnit: "ft_in" },
    ]);
    expect(mocks.saveBodyProfile).not.toHaveBeenCalled();
  });

  it("retries failed height and unit writes together through that same path", async () => {
    mocks.persistProfilePatch.mockRejectedValue(new Error("offline"));
    render(<BodyProfileFields />);

    const height = screen.getByLabelText("Height in centimetres");
    fireEvent.change(height, { target: { value: "170" } });
    fireEvent.blur(height);
    fireEvent.click(screen.getByRole("button", { name: "Feet and inches" }));

    await waitFor(() => expect(mocks.persistProfilePatch).toHaveBeenCalledTimes(2));
    const retry = await screen.findByRole("button", { name: "Try again" });
    mocks.persistProfilePatch.mockResolvedValue(defaultStore());
    fireEvent.click(retry);

    await waitFor(() => expect(mocks.persistProfilePatch).toHaveBeenCalledTimes(3));
    expect(mocks.persistProfilePatch.mock.calls[2]?.[1]).toEqual({
      heightCm: 170,
      heightUnit: "ft_in",
    });
  });
});
