// @vitest-environment jsdom
/**
 * Each companion in every scene (owner, 2026-10-07: "I picked blue to see its unique UI interactions but
 * all interactions are still with sprout"): the pond, swim, bucket, massage and award art are the chosen
 * companion's own, and what is said uses its name.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { MASCOT_KEYS, SCENE_POSES, named, sceneArt } from "./mascots";

const chosen = vi.hoisted(() => ({ mascot: "blueberry" }));
vi.mock("@/components/today/island/well-pet", () => ({ useMascot: () => chosen.mascot, MASCOT_EVENT: "companion-changed" }));
vi.mock("@/components/today/care/sound", () => ({
  play: vi.fn(), unlockAudio: vi.fn(), readMuted: () => true, silence: vi.fn(), writeMuted: vi.fn(),
}));
afterEach(() => { cleanup(); chosen.mascot = "blueberry"; });

describe("scene art for each companion", () => {
  it("keeps Sprout's first paths", () => {
    expect(sceneArt("sprout", "fishing")).toBe("/pet/scene/sprout-fishing.webp");
    expect(sceneArt("sprout", "massage-1")).toBe("/pet/care/massage-1.webp");
    expect(sceneArt("sprout", "bucket-pour")).toBe("/pet/water/sprout-bucket-pour.webp");
    expect(sceneArt("sprout", "award-workout-flex")).toBe("/pet/awards/sprout-workout-flex.webp");
  });

  it("has every pose drawn for every companion, so no scene falls back to Sprout", () => {
    const missing = MASCOT_KEYS.flatMap((mascot) => SCENE_POSES.map((pose) => sceneArt(mascot, pose)))
      .filter((src) => !existsSync(join(process.cwd(), "public", src)));
    expect(missing).toEqual([]);
  });

  it("says Sprout's lines with the chosen companion's name", () => {
    expect(named("Sprout's pond", "blueberry")).toBe("Blu's pond");
    expect(named("Sprout skips a pebble.", "mushroom")).toBe("Button skips a pebble.");
    expect(named("A sprout of moss. Sprout waves.", "peapod")).toBe("A sprout of moss. Pod waves.");
    expect(named("Sprout waves.", "sprout")).toBe("Sprout waves.");
  });
});

describe("the chosen companion in a care scene and the shop", () => {
  it("plays the massage with the companion's own art and words", async () => {
    const { default: CareScenePlayer } = await import("@/components/today/care/CareScenePlayer");
    const { container } = render(<MotionConfig reducedMotion="always"><CareScenePlayer scene="massage" onClose={() => {}} /></MotionConfig>);
    const srcs = [...container.querySelectorAll("img")].map((img) => decodeURIComponent(img.getAttribute("src") ?? ""));
    expect(srcs.some((src) => src.includes("/pet/mascots/blueberry/scene/massage-2.webp"))).toBe(true);
    expect(srcs.some((src) => src.includes("/pet/care/"))).toBe(false);
    expect(screen.getAllByText("Blu feels brand new.").length).toBeGreaterThan(0);
  });

  it("dresses each companion at its own fit, and leaves off what it cannot wear", async () => {
    const { default: DressedSprout } = await import("@/components/today/care/shop/DressedSprout");
    const srcsOf = (el: HTMLElement) => [...el.querySelectorAll("img")].map((img) => decodeURIComponent(img.getAttribute("src") ?? ""));
    const blu = render(<MotionConfig reducedMotion="always">
      <DressedSprout wearing={{ head: "knitted-hat", legs: "shorts" }} mascot="blueberry" label="Blu" /></MotionConfig>);
    const bluSrcs = srcsOf(blu.container);
    expect(bluSrcs.some((src) => src.includes("/pet/mascots/blueberry/content.webp"))).toBe(true);
    expect(bluSrcs.some((src) => src.includes("/pet/shop/knitted-hat.webp"))).toBe(true);
    // Blu's own leaves grow through the hat, never Sprout's.
    expect(bluSrcs.some((src) => src.includes("/pet/shop/blueberry-leaf.webp"))).toBe(true);
    expect(bluSrcs.some((src) => src.includes("/pet/shop/sprout-leaf.webp"))).toBe(false);
    // The shorts are clipped to Blu's outline.
    expect(blu.container.querySelector('[data-mascot="blueberry"] img')?.getAttribute("src")).toContain("shorts");
    blu.unmount();
    // Pod's pod tip has no head for a hat: the hat is left off, the shorts stay on.
    const pod = render(<MotionConfig reducedMotion="always">
      <DressedSprout wearing={{ head: "knitted-hat", legs: "shorts" }} mascot="peapod" label="Pod" /></MotionConfig>);
    const podSrcs = srcsOf(pod.container);
    expect(podSrcs.some((src) => src.includes("knitted-hat") || src.includes("-leaf."))).toBe(false);
    expect(podSrcs.some((src) => src.includes("/pet/shop/shorts.webp"))).toBe(true);
  });
  it("lets Blu wear what is equipped, and says plainly what Pod cannot wear", async () => {
    const { default: CareShop } = await import("@/components/today/care/shop/CareShop");
    const state = { balance: 42, owned: ["leaf-pin", "bucket-hat"], equipped: { pin: "leaf-pin", head: "bucket-hat" },
      rev: 1, receipts: {}, ledger: [] };
    const shop = () => <MotionConfig reducedMotion="always"><CareShop state={state as never} onChange={() => {}} today="2026-10-07" /></MotionConfig>;
    const { rerender } = render(shop());
    expect(screen.getByRole("img", { name: "Blu, wearing leaf pin, bucket hat" })).toBeTruthy();
    const massage = screen.getByRole("button", { name: /^Massage/ });
    expect(decodeURIComponent(massage.querySelector("img")?.getAttribute("src") ?? "")).toContain("/pet/mascots/blueberry/scene/massage-1.webp");
    const pin = screen.getByRole("button", { name: /^Leaf pin/ });
    expect(pin.getAttribute("aria-label")).toBe("Leaf pin, yours, on Blu");
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: "Take off" })).toBeTruthy();
    expect(screen.getAllByText("Blu has it on.").length).toBeGreaterThan(0);

    chosen.mascot = "peapod";
    rerender(shop());
    expect(screen.getByRole("img", { name: "Pod, wearing leaf pin" })).toBeTruthy();
    const hat = screen.getByRole("button", { name: /^Bucket hat/ });
    // Still equipped for the companions that can wear it, but never shown as on Pod.
    expect(hat.getAttribute("aria-label")).toBe("Bucket hat, yours");
    fireEvent.click(hat);
    expect(screen.queryByRole("button", { name: "Take off" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wear" })).toBeNull();
    expect(screen.getAllByText("Yours. Pod cannot wear it; your other companions can.").length).toBeGreaterThan(0);
    expect(document.querySelector("[aria-live=polite]")?.textContent).toBe("Pod cannot wear the bucket hat.");
  });
  it("lets Pod buy a hat for the others without putting it on", async () => {
    const { default: CareShop } = await import("@/components/today/care/shop/CareShop");
    chosen.mascot = "peapod";
    const start = { balance: 42, owned: [], equipped: {}, rev: 1, receipts: {}, ledger: [] };
    const after = { ...start, balance: 17, owned: ["knitted-hat"] };
    const purchase = vi.fn(async () => ({ ok: true, state: after, receipt: { balance: 17 } }));
    const equip = vi.fn();
    const onChange = vi.fn();
    render(<MotionConfig reducedMotion="always"><CareShop state={start as never} onChange={onChange} today="2026-10-07"
      rules={{ purchase, equip } as never} /></MotionConfig>);
    fireEvent.click(screen.getByRole("button", { name: /^Knitted hat/ }));
    expect(screen.getAllByText("Pod cannot wear it; your other companions can.").length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Buy the knitted hat/ })); });
    expect(purchase).toHaveBeenCalledOnce();
    // Owned for the account, never equipped from a companion it does not fit.
    expect(equip).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(after);
    expect(document.querySelector("[aria-live=polite]")?.textContent)
      .toBe("The knitted hat is yours. Pod cannot wear it; your other companions can. 17 Seeds.");
  });
  it("drops a line said for Sprout when the companion changes with the shop open", async () => {
    const { default: CareShop } = await import("@/components/today/care/shop/CareShop");
    chosen.mascot = "sprout";
    const state = { balance: 42, owned: ["leaf-pin"], equipped: { pin: "leaf-pin" }, rev: 1, receipts: {}, ledger: [] };
    const shop = () => <MotionConfig reducedMotion="always"><CareShop state={state as never} onChange={() => {}} today="2026-10-07" /></MotionConfig>;
    const { rerender } = render(shop());
    fireEvent.click(screen.getByRole("button", { name: /^Bucket hat/ }));
    const live = () => document.querySelector("[aria-live=polite]")?.textContent;
    expect(live()).toBe("Sprout tries on the bucket hat.");
    chosen.mascot = "blueberry";
    rerender(shop());
    expect(live()).toBe("");
    chosen.mascot = "sprout";
    rerender(shop());
    expect(live()).toBe("");
  });
});
