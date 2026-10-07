// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HeightField from "@/components/HeightField";
import WeightField from "@/components/WeightField";

afterEach(cleanup);

describe("HeightField", () => {
  it("converts only the displayed value when the unit changes", () => {
    const onChange = vi.fn();
    const onUnitChange = vi.fn();
    const view = render(<HeightField valueCm={165.1} unit="ft_in"
      onChange={onChange} onUnitChange={onUnitChange} />);

    expect((screen.getByLabelText("Feet") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Inches") as HTMLInputElement).value).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Centimetres" }));

    expect(onUnitChange).toHaveBeenCalledWith("cm");
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(<HeightField valueCm={165.1} unit="cm"
      onChange={onChange} onUnitChange={onUnitChange} />);
    expect((screen.getByLabelText("Height in centimetres") as HTMLInputElement).value).toBe("165.1");
  });

  it("keeps invalid inches visible and does not change metric storage", () => {
    const onChange = vi.fn();
    render(<HeightField valueCm={165.1} unit="ft_in"
      onChange={onChange} onUnitChange={() => {}} />);

    const inches = screen.getByLabelText("Inches");
    fireEvent.change(inches, { target: { value: "12" } });

    expect((inches as HTMLInputElement).value).toBe("12");
    expect(screen.getByRole("alert").textContent).toContain("0 to 11");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stores a valid feet and inches edit as centimetres", () => {
    const onChange = vi.fn();
    render(<HeightField valueCm={165.1} unit="ft_in"
      onChange={onChange} onUnitChange={() => {}} />);

    fireEvent.change(screen.getByLabelText("Inches"), { target: { value: "6" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText("Inches"));
    expect(onChange).toHaveBeenLastCalledWith(167.6);
  });

  it("does not persist a partial feet edit while inches still show the previous value", () => {
    const onChange = vi.fn();
    render(<HeightField valueCm={165.1} unit="ft_in"
      onChange={onChange} onUnitChange={() => {}} />);

    fireEvent.change(screen.getByLabelText("Feet"), { target: { value: "6" } });
    expect((screen.getByLabelText("Inches") as HTMLInputElement).value).toBe("5");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses numeric inputs and 44px unit targets with visible labels", () => {
    render(<HeightField valueCm={null} unit="ft_in" onChange={() => {}} onUnitChange={() => {}} />);
    expect(screen.getByText("Height")).toBeTruthy();
    expect(screen.getByLabelText("Feet").getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByLabelText("Inches").getAttribute("inputmode")).toBe("numeric");
    for (const name of ["Feet", "Inches"]) {
      const input = screen.getByLabelText(name);
      expect(input.className).toContain("well");
      expect(input.className).toContain("placeholder:text-muted");
      expect(input.getAttribute("placeholder")).not.toBe("");
    }
    expect(screen.getByRole("button", { name: "Feet and inches" }).className).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Centimetres" }).className).toContain("min-h-11");
  });

  it("gives the centimetre input the same visible well and placeholder", () => {
    render(<HeightField valueCm={null} unit="cm" onChange={() => {}} onUnitChange={() => {}} />);
    const input = screen.getByLabelText("Height in centimetres");
    expect(input.className).toContain("well");
    expect(input.className).toContain("placeholder:text-muted");
    expect(input.getAttribute("placeholder")).not.toBe("");
  });
});

describe("WeightField", () => {
  it("buffers a weight until blur and only then commits a value or a real clear", () => {
    const onChange = vi.fn();
    render(<WeightField valueKg={null} unit="lb"
      onChange={onChange} onUnitChange={() => {}} />);

    const input = screen.getByLabelText("Weight in pounds");
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.change(input, { target: { value: "150" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(68.039);

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the selected unit without changing kilogram storage on a toggle", () => {
    const onChange = vi.fn();
    const onUnitChange = vi.fn();
    const view = render(<WeightField valueKg={60} unit="lb"
      onChange={onChange} onUnitChange={onUnitChange} />);

    expect((screen.getByLabelText("Weight in pounds") as HTMLInputElement).value).toBe("132.3");
    fireEvent.click(screen.getByRole("button", { name: "Kilograms" }));
    expect(onUnitChange).toHaveBeenCalledWith("kg");
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(<WeightField valueKg={60} unit="kg"
      onChange={onChange} onUnitChange={onUnitChange} />);
    expect((screen.getByLabelText("Weight in kilograms") as HTMLInputElement).value).toBe("60");
  });

  it("uses a visible well, a placeholder, and the selected unit in validation copy", () => {
    render(<WeightField valueKg={60} unit="lb" onChange={() => {}} onUnitChange={() => {}} />);
    const input = screen.getByLabelText("Weight in pounds");
    expect(input.className).toContain("well");
    expect(input.className).toContain("placeholder:text-muted");
    expect(input.getAttribute("placeholder")).not.toBe("");
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByRole("alert").textContent).toContain("44 to 882 lb");
    expect(screen.getByRole("alert").textContent).not.toContain("kg");
  });
});
