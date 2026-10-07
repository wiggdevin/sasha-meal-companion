// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RuleReviewCard from "./RuleReviewCard";

const submitted = vi.hoisted(() => vi.fn(async () => ({ status: "ok" as const,
  review: { required: false, candidateAllergens: [], candidateCategories: [], rev: 4 } })));
const loaded = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock("@/lib/rule-review-client", () => ({
  loadRuleReview: loaded, submitRuleReview: submitted,
}));

afterEach(cleanup);

describe("historical rule review card", () => {
  it("requires an explicit choice for every rule before saving once", async () => {
    submitted.mockClear();
    render(<RuleReviewCard initial={{ required: true, candidateAllergens: ["gluten"],
      candidateCategories: ["beans"], rev: 3 }} />);
    const save = screen.getByRole("button", { name: "Save my choices" });
    expect(save.hasAttribute("disabled")).toBe(true);
    const gluten = within(screen.getByRole("group", { name: "Gluten choice" }));
    const beans = within(screen.getByRole("group", { name: "Beans and pulses choice" }));
    expect(gluten.getByRole("button", { name: "Keep" }).getAttribute("aria-pressed")).toBe("false");
    expect(beans.getByRole("button", { name: "Remove" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(gluten.getByRole("button", { name: "Keep" }));
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(beans.getByRole("button", { name: "Remove" }));
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(submitted).toHaveBeenCalledWith({
      allergens: { gluten: "keep" }, categories: { beans: "remove" },
    }, 3));
    expect(screen.queryByRole("button", { name: "Save my choices" })).toBeNull();
  });

  it("refreshes the rule list when another device finishes the review", async () => {
    submitted.mockResolvedValueOnce({ status: "conflict" } as never);
    loaded.mockResolvedValueOnce({ required: false, candidateAllergens: [],
      candidateCategories: [], rev: 4 });
    const completed = vi.fn();
    render(<RuleReviewCard initial={{ required: true, candidateAllergens: ["gluten"],
      candidateCategories: [], rev: 3 }} onCompleted={completed} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Gluten choice" }))
      .getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Save my choices" }));
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Review food rules" })).toBeNull();
  });
});
