// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceStore } from "@/lib/shopping/contracts";

const leaflet = vi.hoisted(() => {
  const markers: { latlng: [number, number]; options: Record<string, unknown>; handlers: Record<string, () => void>;
    icon: { options: { html: string } } }[] = [];
  const map = {
    invalidateSize: vi.fn(), remove: vi.fn(), fitBounds: vi.fn(),
    dragging: { enable: vi.fn(), disable: vi.fn() },
  };
  const api = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn((options: { html: string }) => ({ options })),
    latLngBounds: vi.fn(() => ({ pad: () => ({}) })),
    marker: vi.fn((latlng: [number, number], options: Record<string, unknown>) => {
      const marker = { latlng, options, handlers: {} as Record<string, () => void>,
        icon: options.icon as { options: { html: string } },
        addTo() { return marker; },
        on(name: string, fn: () => void) { marker.handlers[name] = fn; return marker; },
        setIcon(icon: { options: { html: string } }) { marker.icon = icon; },
        remove: vi.fn() };
      markers.push(marker);
      return marker;
    }),
  };
  return { api, map, markers };
});
vi.mock("leaflet", () => ({ default: leaflet.api }));
vi.mock("leaflet/dist/leaflet.css", () => ({}));

import StoreMap, { ATTRIBUTION, TILE_URL, TWO_FINGER_HINT } from "./StoreMap";
import StepStores, { type PlacesPort } from "./build/StepStores";

const store = (index: number): PlaceStore =>
  ({ id: `s${index}`, name: `Store ${index}`, lat: 37.76 + index / 1000, lon: -122.42, distanceM: 300 * index });
const stores = Array.from({ length: 7 }, (_, index) => store(index + 1));

beforeEach(() => { leaflet.markers.length = 0; vi.clearAllMocks(); });
afterEach(() => { cleanup(); delete (window as { ontouchstart?: unknown }).ontouchstart; });

describe("the store map", () => {
  it("shows the OpenStreetMap attribution and uses OSM tiles at zoom 12 to 17", () => {
    render(<StoreMap center={{ lat: 37.76, lon: -122.42 }} stores={stores} pickedIds={[]} onToggle={() => {}} />);
    expect(screen.getByText(ATTRIBUTION)).toBeTruthy();
    expect(ATTRIBUTION).toBe("© OpenStreetMap contributors");
    expect(leaflet.api.tileLayer).toHaveBeenCalledWith(TILE_URL, expect.objectContaining({ minZoom: 12, maxZoom: 17 }));
    expect(TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });

  it("has a row list that mirrors the map's markers and picks", () => {
    const onToggle = vi.fn();
    render(<StoreMap center={{ lat: 37.76, lon: -122.42 }} stores={stores.slice(0, 3)} pickedIds={["s2"]}
      onToggle={onToggle} />);
    const rows = screen.getAllByRole("button", { pressed: undefined }).filter((row) => row.closest("ul"));
    expect(rows.map((row) => row.textContent)).toEqual(["Store 1300 m", "✓Store 2600 m", "Store 3900 m"]);
    expect(leaflet.markers.map((marker) => marker.options.title)).toEqual(["Store 1", "Store 2", "Store 3"]);
    expect(leaflet.markers[1].icon.options.html).toContain("✓");
    expect(leaflet.markers[0].icon.options.html).not.toContain("✓");
    expect(leaflet.api.divIcon).toHaveBeenCalledWith(expect.objectContaining({ iconSize: [44, 44] }));
    fireEvent.click(rows[0]);
    act(() => { leaflet.markers[2].handlers.click(); });
    expect(onToggle.mock.calls.map(([row]) => row.id)).toEqual(["s1", "s3"]);
  });

  it("allows at most 5 picks", () => {
    const onToggle = vi.fn();
    const picked = ["s1", "s2", "s3", "s4", "s5"];
    render(<StoreMap center={{ lat: 37.76, lon: -122.42 }} stores={stores} pickedIds={picked} onToggle={onToggle} />);
    const sixth = screen.getByRole("button", { name: /Store 6/ });
    expect((sixth as HTMLButtonElement).disabled).toBe(true);
    act(() => { leaflet.markers[5].handlers.click(); });
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByText(/5 of 5 picked/)).toBeTruthy();
  });

  it("calls invalidateSize after open and on resize", async () => {
    render(<StoreMap center={{ lat: 37.76, lon: -122.42 }} stores={stores} pickedIds={[]} onToggle={() => {}} />);
    await waitFor(() => expect(leaflet.map.invalidateSize).toHaveBeenCalled(), { timeout: 2000 });
    const before = leaflet.map.invalidateSize.mock.calls.length;
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(leaflet.map.invalidateSize.mock.calls.length).toBe(before + 1);
  });

  it("moves with two fingers on a touch screen and says so", () => {
    (window as { ontouchstart?: unknown }).ontouchstart = null;
    render(<StoreMap center={{ lat: 37.76, lon: -122.42 }} stores={stores} pickedIds={[]} onToggle={() => {}} />);
    expect(leaflet.api.map).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dragging: false, touchZoom: true }));
    expect(screen.getByText(`${TWO_FINGER_HINT}.`)).toBeTruthy();
    const box = screen.getByRole("application");
    fireEvent.touchStart(box, { touches: [{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }] });
    expect(leaflet.map.dragging.enable).toHaveBeenCalled();
  });
});

describe("the stores step", () => {
  function places(over: Partial<PlacesPort> = {}): PlacesPort {
    return {
      geocode: vi.fn(async () => ({ status: "ok" as const, place: { lat: 37.76, lon: -122.42, label: "Mission District, San Francisco" } })),
      stores: vi.fn(async () => ({ status: "ok" as const, stores: stores.slice(0, 2) })),
      locate: vi.fn(async () => ({ lat: 37.76, lon: -122.42 })),
      ...over,
    };
  }

  it("asks for the location only after a tap on Use my location", async () => {
    const port = places();
    render(<StepStores accountId="u1" countryCode="US" picked={[]} onToggle={() => {}} onNext={() => {}}
      onSkip={() => {}} places={port} />);
    expect(port.locate).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use my location" })); });
    expect(port.locate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Near your location. Is this right?")).toBeTruthy();
    expect(port.stores).not.toHaveBeenCalled();
  });

  it("confirms the place before stores load, then shows the map", async () => {
    window.localStorage.setItem("shopping-location:u1", "94110");
    const port = places();
    render(<StepStores accountId="u1" countryCode="US" picked={[]} onToggle={() => {}} onNext={() => {}}
      onSkip={() => {}} places={port} />);
    expect((screen.getByLabelText("ZIP code or area") as HTMLInputElement).value).toBe("94110");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find stores" })); });
    expect(port.geocode).toHaveBeenCalledWith("94110", "US");
    expect(screen.getByText("Near Mission District, San Francisco. Is this right?")).toBeTruthy();
    expect(port.stores).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Yes, show stores" })); });
    expect(port.stores).toHaveBeenCalledWith(37.76, -122.42);
    expect(await screen.findByText(ATTRIBUTION)).toBeTruthy();
  });

  it("says store search is unavailable and keeps Skip", async () => {
    const onSkip = vi.fn();
    const port = places({ geocode: vi.fn(async () => ({ status: "unavailable" as const })) });
    render(<StepStores accountId="u2" countryCode={null} picked={[]} onToggle={() => {}} onNext={() => {}}
      onSkip={onSkip} places={port} />);
    fireEvent.change(screen.getByLabelText("ZIP code or area"), { target: { value: "D02" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find stores" })); });
    expect(port.geocode).not.toHaveBeenCalled();
    expect(screen.getByText("Pick your country first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "IE" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find stores" })); });
    expect(screen.getByText("Store search isn't available right now. You can skip this step.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("remembers picked store names on this phone", async () => {
    const onToggle = vi.fn();
    render(<StepStores accountId="u3" countryCode="US" picked={[]} onToggle={onToggle} onNext={() => {}}
      onSkip={() => {}} places={places()} />);
    fireEvent.change(screen.getByLabelText("ZIP code or area"), { target: { value: "94110" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find stores" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Yes, show stores" })); });
    fireEvent.click(await screen.findByRole("button", { name: /Store 1/ }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
    expect(JSON.parse(window.localStorage.getItem("shopping-picked-stores:u3") ?? "[]")).toEqual(["Store 1"]);
  });
});
