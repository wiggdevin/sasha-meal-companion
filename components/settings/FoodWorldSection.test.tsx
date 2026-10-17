// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const client = vi.hoisted(() => ({ view: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/foods/world-open-client", () => ({
  readFoodWorldView: (...a: unknown[]) => client.view(...a),
  chooseFoodWorld: (...a: unknown[]) => client.choose(...a),
}));

const { default: FoodWorldSection, FOOD_WORLD_COPY } = await import("./FoodWorldSection");
const { default: OpenWorldInvitation } = await import("@/components/foods/OpenWorldInvitation");

beforeEach(() => {
  localStorage.clear();
  unbindAccount(); markAccountReady(bindAccount(TEST_USER));
  client.view.mockReset(); client.choose.mockReset();
});
afterEach(cleanup);

describe("Settings › Food ideas", () => {
  it("is hidden while the account cannot open, and on a failed read", async () => {
    client.view.mockResolvedValueOnce({ world: "closed", eligible: false });
    const { container, rerender } = render(<FoodWorldSection />);
    await waitFor(() => expect(client.view).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    client.view.mockResolvedValueOnce(null);
    rerender(<FoodWorldSection key="again" />);
    await waitFor(() => expect(client.view).toHaveBeenCalledTimes(2));
    expect(container.textContent).toBe("");
  });

  it("turns the open food list on through the existing route and uses Favored wording", async () => {
    client.view.mockResolvedValue({ world: "closed", eligible: true });
    client.choose.mockImplementation(async () => {
      client.view.mockResolvedValue({ world: "open", eligible: true });
      return { ok: true, world: "open" };
    });
    render(<FoodWorldSection />);
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Favored");
    expect(document.body.textContent).not.toMatch(/\bEats\b/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(client.choose).toHaveBeenCalledWith(expect.anything(), "open");
  });

  it("switches back off", async () => {
    client.view.mockResolvedValue({ world: "open", eligible: false });
    client.choose.mockImplementation(async () => {
      client.view.mockResolvedValue({ world: "closed", eligible: true });
      return { ok: true, world: "closed" };
    });
    render(<FoodWorldSection />);
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(client.choose).toHaveBeenCalledWith(expect.anything(), "closed");
  });

  it("shows the review line on a condition review", async () => {
    client.view.mockResolvedValue({ world: "closed", eligible: true });
    client.choose.mockResolvedValue({ ok: false, reason: "condition_review" });
    render(<FoodWorldSection />);
    fireEvent.click(await screen.findByRole("switch"));
    expect(await screen.findByText(FOOD_WORLD_COPY.review)).toBeTruthy();
  });
});

describe("the open-world invitation", () => {
  it("shows only for an eligible closed account and can be dismissed for good", async () => {
    client.view.mockResolvedValue({ world: "closed", eligible: true });
    const { unmount } = render(<OpenWorldInvitation />);
    await screen.findByText("See more food ideas");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("See more food ideas")).toBeNull();
    unmount();
    render(<OpenWorldInvitation />);
    expect(screen.queryByText("See more food ideas")).toBeNull();
  });

  it("renders nothing for a held, open or unreadable account", async () => {
    for (const view of [{ world: "closed", eligible: false }, { world: "open", eligible: false }, null]) {
      client.view.mockResolvedValueOnce(view);
      const { container, unmount } = render(<OpenWorldInvitation />);
      await waitFor(() => expect(client.view).toHaveBeenCalled());
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("accepting calls the route and closes the card", async () => {
    client.view.mockResolvedValue({ world: "closed", eligible: true });
    client.choose.mockResolvedValue({ ok: true, world: "open" });
    render(<OpenWorldInvitation />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on open food list" }));
    await waitFor(() => expect(screen.queryByText("See more food ideas")).toBeNull());
    expect(client.choose).toHaveBeenCalledWith(expect.anything(), "open");
  });
});
