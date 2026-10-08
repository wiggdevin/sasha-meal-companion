// @vitest-environment jsdom
/** Settings › "How Sasha works": closed by default, opens the shared tour overview on tap. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import HowSashaWorksCard from "./HowSashaWorksCard";

afterEach(cleanup);

describe("HowSashaWorksCard", () => {
  it("renders closed, with no overview dialog mounted", () => {
    render(<HowSashaWorksCard />);
    expect(screen.getByRole("button", { name: "Show me how it works" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders open, with the tour overview dialog, after a tap on its trigger", () => {
    render(<HowSashaWorksCard />);
    fireEvent.click(screen.getByRole("button", { name: "Show me how it works" }));
    expect(screen.getByRole("dialog", { name: "Meet Sasha" })).toBeTruthy();
  });
});
