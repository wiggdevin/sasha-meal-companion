// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { useRecipeAccess } from "@/lib/recipe-access-client";
import EatsView from "@/components/EatsView";

vi.mock("@/components/FavoritesStrip", () => ({ default: () => null }));
vi.mock("@/components/CatalogFavorites", () => ({ default: () => null }));
vi.mock("@/components/RecipeDiscovery", () => ({ default: () => null }));
vi.mock("@/components/MyFoods", () => ({ default: () => null }));

function Probe() {
  const access = useRecipeAccess();
  const [draft, setDraft] = useState("");
  return <>
    <p role="status">{access.loading ? "checking" : access.enabled ? "enabled"
      : access.unavailable ? "unavailable" : "disabled"}</p>
    {access.unavailable && <button type="button" onClick={access.retry}>Retry</button>}
    {access.enabled && <input aria-label="Recipe draft" value={draft} onChange={(event) => setDraft(event.target.value)} />}
  </>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); unbindAccount(); });

it("offers a retry on Eats when recipe access could not be checked", () => {
  const retry = vi.fn();
  render(<EatsView recipeAccess={{ enabled: false, loading: false, unavailable: true, retry }} />);
  // Recipes is one closed card (2026-10-05); its body opens from the header.
  fireEvent.click(screen.getByRole("button", { name: /^Recipes/ }));
  expect(screen.getByText("Recipe access could not be checked. Try again.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("keeps the mounted draft through a same-account visibility recheck, then removes it on denial", async () => {
  const pending: ((response: Response) => void)[] = [];
  const send = vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  vi.stubGlobal("fetch", send);
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => pending[0](Response.json({ enabled: true })));
  const input = screen.getByRole("textbox", { name: "Recipe draft" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Dinner idea in progress" } });

  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("textbox", { name: "Recipe draft" })).toBe(input);
  expect(input.value).toBe("Dinner idea in progress");
  await act(async () => pending[1](Response.json({ enabled: true })));
  expect(screen.getByRole("textbox", { name: "Recipe draft" })).toBe(input);
  expect(input.value).toBe("Dinner idea in progress");

  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("textbox", { name: "Recipe draft" })).toBe(input);
  await act(async () => pending[2](Response.json({ error: "not_found" }, { status: 404 })));
  expect(screen.queryByRole("textbox", { name: "Recipe draft" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("unavailable");
});

it("shows a recoverable unavailable state after a transient failure and retries only on request", async () => {
  const send = vi.fn()
    .mockRejectedValueOnce(new Error("network offline"))
    .mockResolvedValueOnce(Response.json({ enabled: true }));
  vi.stubGlobal("fetch", send);
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<Probe />);

  expect(await screen.findByText("unavailable")).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("enabled")).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(2);
});

it("keeps an explicit server denial distinct from an unavailable check", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ enabled: false })));
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<Probe />);
  expect(await screen.findByText("disabled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("does not apply an older account's access response after an account switch", async () => {
  const pending: ((response: Response) => void)[] = [];
  const send = vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  vi.stubGlobal("fetch", send);
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  act(() => { unbindAccount(); markAccountReady(bindAccount("22222222-2222-4222-8222-222222222222")); });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await act(async () => {
    pending[0](Response.json({ enabled: true }));
    pending[1](Response.json({ enabled: false }));
  });
  expect(await screen.findByText("disabled")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Recipe draft" })).toBeNull();
});

it("clears confirmed access when the account logs out or switches", async () => {
  const pending: ((response: Response) => void)[] = [];
  const send = vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  vi.stubGlobal("fetch", send);
  markAccountReady(bindAccount("11111111-1111-4111-8111-111111111111"));
  render(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => pending[0](Response.json({ enabled: true })));
  expect(screen.getByRole("textbox", { name: "Recipe draft" })).toBeTruthy();

  act(() => { unbindAccount(); });
  expect(screen.queryByRole("textbox", { name: "Recipe draft" })).toBeNull();
  act(() => { markAccountReady(bindAccount("22222222-2222-4222-8222-222222222222")); });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("textbox", { name: "Recipe draft" })).toBeNull();
});
