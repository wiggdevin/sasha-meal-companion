// @vitest-environment jsdom
/**
 * Settings › Cuisines and country (Phase 18 W5): every account, both optional. A chip saves the
 * whole list in vocabulary order; a seventh cannot be chosen; the country saves the picked ISO code,
 * and "Prefer not to say" saves null (clears it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultSettings } from "@/lib/store";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";

const place = vi.hoisted(() => ({ savePlaceSetting: vi.fn(async () => {}) }));
vi.mock("@/lib/profile/cuisines-client", () => ({ savePlaceSetting: place.savePlaceSetting }));
const taste = vi.hoisted(() => ({
  enabled: vi.fn<() => Promise<"enabled" | "disabled" | "unknown">>(async () => "disabled"),
  request: vi.fn(),
}));
vi.mock("@/lib/profile/taste-enabled-client", () => ({ readTasteChipsEnabled: taste.enabled }));
vi.mock("@/lib/profile/prefs-client", () => ({ requestTasteChips: taste.request }));
// Followups #1: lib/profile/taste-dislike-remove-client.ts is the REAL, landed module —
// deliberately not mocked, so the remove/Undo describe block below exercises it for real against
// a faked global `fetch`. Only the lower-level sync write it settles onto is mocked (same seam
// tests/profile/taste-dislike-remove-client.test.ts itself uses), so a test never touches IndexedDB.
const sync = vi.hoisted(() => ({ applyServerUserSettings: vi.fn(async () => true) }));
vi.mock("@/lib/sync/client", () => ({ applyServerUserSettings: sync.applyServerUserSettings }));
// A plain select stands in for the kit's picker, which these tests do not exercise.
vi.mock("@/components/ui/GlassSelect", () => ({
  default: ({ value, onChange, options, "aria-label": label }: {
    value: string; onChange: (value: string) => void; options: { value: string; label: string }[];
    "aria-label": string;
  }) => <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));

const { default: CuisinesSection } = await import("@/components/settings/CuisinesSection");

const settingsWith = (extra: Partial<Settings>): Settings => ({ ...defaultSettings(), ...extra });
const chip = (name: string) => screen.getByRole("button", { name });

afterEach(() => { cleanup(); vi.clearAllMocks(); taste.enabled.mockResolvedValue("disabled"); });

const withDislikes = (dislikes: string[]): ProfileDietPrefs =>
  ({ taste: { dislikes } }) as unknown as ProfileDietPrefs;

describe("Settings › Cuisines and country", () => {
  it("shows nothing chosen and saves a picked cuisine as the whole list, in vocabulary order", async () => {
    render(<CuisinesSection settings={settingsWith({ cuisines: ["korean"] })} />);
    expect(chip("Korean").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("Korean"));
    expect(screen.getByText("0 of 6 chosen.")).toBeTruthy();
    await waitFor(() => expect(place.savePlaceSetting).toHaveBeenLastCalledWith({ cuisines: [] }));
    fireEvent.click(chip("Japanese"));
    fireEvent.click(chip("Italian"));
    await waitFor(() => expect(place.savePlaceSetting).toHaveBeenLastCalledWith({ cuisines: ["italian", "japanese"] }));
  });

  it("with six chosen, keeps the rest disabled until one is turned off", () => {
    render(<CuisinesSection settings={settingsWith({
      cuisines: ["american", "italian", "chinese", "japanese", "korean", "african"] })} />);
    expect(screen.getByText("6 of 6 chosen. Turn one off to pick another.")).toBeTruthy();
    expect(chip("Caribbean").hasAttribute("disabled")).toBe(true);
    expect(chip("Korean").hasAttribute("disabled")).toBe(false);
    fireEvent.click(chip("Korean"));
    expect(chip("Caribbean").hasAttribute("disabled")).toBe(false);
  });

  it("saves a country chosen from the list, and Prefer not to say clears it", async () => {
    render(<CuisinesSection settings={settingsWith({ countryCode: null })} />);
    const country = screen.getByRole("combobox", { name: "Country" }) as HTMLSelectElement;
    expect(country.value).toBe("");
    expect(country.options[0].textContent).toBe("Prefer not to say");
    expect(country.options[1].textContent).toBe("United States");
    fireEvent.change(country, { target: { value: "US" } });
    await waitFor(() => expect(place.savePlaceSetting).toHaveBeenLastCalledWith({ countryCode: "US" }));
    fireEvent.change(country, { target: { value: "" } });
    await waitFor(() => expect(place.savePlaceSetting).toHaveBeenLastCalledWith({ countryCode: null }));
    expect(screen.getByText(/only the United States will change your food ideas/)).toBeTruthy();
  });
});

describe("Settings › Your taste card (hotfix: a bare heading with the flag off and no dislikes)", () => {
  it("renders no card at all with the flag off and no stored dislikes", async () => {
    taste.enabled.mockResolvedValue("disabled");
    const { container } = render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes([]) })} />);
    await waitFor(() => expect(taste.enabled).toHaveBeenCalled());
    expect(screen.queryByText("Your taste")).toBeNull();
    expect(container.querySelector("legend")?.textContent).not.toBe("Your taste");
  });

  it("with the flag off but stored dislikes, shows the card with the read-only pills and no input field", async () => {
    taste.enabled.mockResolvedValue("disabled");
    render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes(["f:Okra"]) })} />);
    await waitFor(() => expect(taste.enabled).toHaveBeenCalled());
    expect(screen.getByText("Your taste")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Your current taste dislikes" })).toBeTruthy();
    expect(screen.getByText("Okra")).toBeTruthy();
    expect(screen.queryByLabelText("A taste, in your own words")).toBeNull();
  });

  it("with the flag enabled, shows the card and the input field", async () => {
    taste.enabled.mockResolvedValue("enabled");
    render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes([]) })} />);
    expect(await screen.findByText("Your taste")).toBeTruthy();
    expect(await screen.findByLabelText("A taste, in your own words")).toBeTruthy();
  });

  it("hides the whole card, not just the field, once the field itself learns the flag went off mid-session", async () => {
    // Sol BLOCK: CuisinesSection held its own earlier "enabled" answer, so when TasteChipsField
    // later found the flag off via requestTasteChips and hid itself, the card's heading and
    // caption kept showing over it. TasteChipsField's onDisabled now tells the parent too.
    taste.enabled.mockResolvedValue("enabled");
    taste.request.mockResolvedValue({ ok: false, reason: "disabled" });
    render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes([]) })} />);
    const field = await screen.findByLabelText("A taste, in your own words");
    fireEvent.change(field, { target: { value: "cilantro" } });
    fireEvent.blur(field);
    await waitFor(() => expect(screen.queryByText("Your taste")).toBeNull());
    expect(screen.queryByLabelText("A taste, in your own words")).toBeNull();
  });

  it("probes the flag exactly once, so the card and the field can never disagree on two separate reads", async () => {
    // Sol BLOCK: CuisinesSection and TasteChipsField each probing the flag independently can land
    // two different answers (a transient blip on one, or the flag flipping between them) and show
    // the card with nothing inside it again. TasteChipsField now takes CuisinesSection's own answer
    // as `availability` instead of probing for itself -- verified here by the call count, since a
    // mocked single resolved value can't otherwise distinguish "probed once" from "probed twice".
    taste.enabled.mockResolvedValue("enabled");
    render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes([]) })} />);
    await screen.findByLabelText("A taste, in your own words");
    expect(taste.enabled).toHaveBeenCalledTimes(1);
  });
});

const TEST_USER = "22222222-2222-4222-8222-222222222222";
const ROW = { rev: 9, diet_prefs: { taste: { dislikes: [] } } };
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Settings › remove one taste dislike (Followups #1)", () => {
  beforeEach(() => { bindAccount(TEST_USER); });
  afterEach(() => { unbindAccount(); });

  it("removes the pill on a 200 and offers Undo, which brings it back", async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(json(200, { status: "removed", actionId: "a1", key: "f:Okra", settings: ROW }))
      .mockImplementationOnce(json(200, {
        status: "undone", actionId: "a1", key: "f:Okra", restored: true, capped: false, settings: ROW,
      }));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes(["f:Okra"]) })} />);
      expect(screen.getByText("Okra")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Remove Okra from your taste dislikes" }));
      await waitFor(() => expect(screen.queryByText("Okra")).toBeNull());
      await waitFor(() => expect(sync.applyServerUserSettings).toHaveBeenCalledWith(expect.anything(), ROW));
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(screen.getByText("Okra")).toBeTruthy());
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [removeUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const [undoUrl, undoInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
      expect(removeUrl).toBe("/api/profile/taste/dislikes/remove");
      expect(undoUrl).toBe("/api/profile/taste/dislikes/remove/undo");
      expect(JSON.parse(String(undoInit.body))).toEqual({ actionId: "a1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the pill and shows a message on a failed remove", async () => {
    vi.stubGlobal("fetch", vi.fn(json(502, { error: "taste_dislike_remove_failed", message: "That did not save. Try again." })));
    try {
      render(<CuisinesSection settings={settingsWith({ dietPrefs: withDislikes(["f:Okra"]) })} />);
      fireEvent.click(screen.getByRole("button", { name: "Remove Okra from your taste dislikes" }));
      await waitFor(() => expect(screen.getByText("That did not save. Try again.")).toBeTruthy());
      expect(screen.getByText("Okra")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
