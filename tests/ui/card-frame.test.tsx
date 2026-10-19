/** @vitest-environment jsdom */
/**
 * CardFrame (components/ui/CardFrame.tsx, UI makeover §3.3): the one card frame. Sizes map to one
 * class each, the face alternates with depth so a card never repeats the card behind it, a fourth
 * level throws in development, the whole card can be one 44 px button with Enter and Space, and the
 * meta is a single truncating line.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CardFrame, { resolveCardFace } from "@/components/ui/CardFrame";

afterEach(() => { cleanup(); });

const faceOf = (el: Element) => (el.classList.contains("surface") ? el : el.querySelector(".surface"))!;

describe("CardFrame", () => {
  it("maps each size to one size class, md by default", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const { container } = render(<CardFrame size={size} title={size} />);
      const face = faceOf(container.firstElementChild!);
      expect(face.classList.contains(`card-${size}`)).toBe(true);
      cleanup();
    }
    const { container } = render(<CardFrame title="Default" />);
    expect(faceOf(container.firstElementChild!).classList.contains("card-md")).toBe(true);
  });

  it("gives lg the card title role and sm/md the 16 px semibold title", () => {
    render(<><CardFrame size="lg" title="Big" /><CardFrame size="sm" title="Small" titleAs="h3" /></>);
    expect(screen.getByRole("heading", { name: "Big", level: 2 }).className).toContain("text-title");
    const small = screen.getByRole("heading", { name: "Small", level: 3 });
    expect(small.className).toContain("text-body");
    expect(small.className).toContain("font-semibold");
  });

  it("alternates faces with depth: raised, inset, raised", () => {
    const { container } = render(
      <CardFrame title="One"><CardFrame title="Two"><CardFrame title="Three" /></CardFrame></CardFrame>,
    );
    const faces = Array.from(container.querySelectorAll(".surface"));
    expect(faces.map((f) => ["card-ivory", "card-recess", "card-olive"].find((c) => f.classList.contains(c))))
      .toEqual(["card-ivory", "card-recess", "card-ivory"]);
    expect(container.querySelectorAll(".shell")).toHaveLength(1);
  });

  it("never nests the same tone: an explicit repeat of the parent's face steps away from it", () => {
    expect(resolveCardFace({ tone: "ivory", parent: "raised", depth: 1 })).toBe("inset");
    expect(resolveCardFace({ level: "inset", parent: "inset", depth: 2 })).toBe("raised");
    expect(resolveCardFace({ parent: null, depth: 0 })).toBe("raised");
    expect(resolveCardFace({ parent: "olive", depth: 1 })).toBe("raised");
    expect(resolveCardFace({ tone: "olive", parent: "raised", depth: 1 })).toBe("olive");
  });

  it("paints the olive tone with on-primary text", () => {
    render(<CardFrame tone="olive" title="Have AI build my list" meta="Pick foods and meals, yes or no." />);
    const heading = screen.getByRole("heading", { name: "Have AI build my list" });
    expect(heading.className).toContain("text-on-primary");
    expect(heading.closest(".surface")!.classList.contains("card-olive")).toBe(true);
  });

  it("throws in development at a fourth level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(
      <CardFrame><CardFrame><CardFrame><CardFrame title="Four" /></CardFrame></CardFrame></CardFrame>,
    )).toThrow(/no fourth level/);
    spy.mockRestore();
  });

  it("makes the whole card one button at least 44 px tall, with Enter and Space", () => {
    const onClick = vi.fn();
    render(<CardFrame title="Open trends" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Open trends" });
    expect(button.getAttribute("tabindex")).toBe("0");
    expect(button.className).toContain("min-h-11");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    fireEvent.keyDown(button, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("is a plain region, not a button, without onClick", () => {
    render(<CardFrame as="section" title="Your week" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("region", { name: "Your week" })).toBeTruthy();
  });

  it("keeps the meta to one truncating line", () => {
    render(<CardFrame title="List" meta="20–26 Oct · 12 items · 3 in cart" />);
    const meta = screen.getByText("20–26 Oct · 12 items · 3 in cart");
    expect(meta.tagName).toBe("P");
    expect(meta.className).toContain("truncate");
    expect(meta.className).toContain("text-muted");
  });

  it("renders the aside and footer", () => {
    render(<CardFrame title="Foods" aside={<span>12</span>} footer={<button type="button">Edit</button>} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("puts layout classes on the outer element only", () => {
    const { container } = render(<CardFrame className="mt-2" title="Layout" />);
    expect(container.firstElementChild!.classList.contains("mt-2")).toBe(true);
    expect(container.querySelector(".surface")!.classList.contains("mt-2")).toBe(false);
  });
});
