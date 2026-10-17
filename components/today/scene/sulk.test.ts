import { describe, expect, it } from "vitest";
import { ANNOYED_MS, LOOK_BACK_MS, POKE_SULK_MS, SULK_LINES, initialSulk, nextChange, poke, pose, sulkLine } from "./sulk";

describe("Sprout's sulk", () => {
  it("never sulks on its own: unpoked, it fishes with no sulk line (OD19)", () => {
    const s = initialSulk();
    expect(pose(s, 0)).toBe("fishing");
    expect(sulkLine(s, 0)).toBeNull();
    expect(nextChange(s, 0)).toBeNull();
  });

  it("greets the first two pokes, sulks on the third, and looks back with tears when poked sulking", () => {
    let s = initialSulk();
    let r = poke(s, 0); s = r.state; expect(r.reaction).toBe("greet");
    r = poke(s, 1000); s = r.state; expect(r.reaction).toBe("greet");
    r = poke(s, 2000); s = r.state; expect(r.reaction).toBe("lookBack");
    expect(pose(s, 2000 + LOOK_BACK_MS - 1)).toBe("lookback");
    expect(pose(s, 2000 + LOOK_BACK_MS + 1)).toBe("sulk");
    expect(sulkLine(s, 2500)).toBe(SULK_LINES.poke);
    expect(pose(s, 2000 + POKE_SULK_MS + 1)).toBe("fishing");
  });

  it("forgets pokes older than the window", () => {
    let s = initialSulk();
    s = poke(s, 0).state; s = poke(s, 1000).state;
    const r = poke(s, 20_000);
    expect(r.reaction).toBe("greet");
  });

  it("is annoyed on the fourth poke inside the window, and more pokes do not extend it", () => {
    let s = initialSulk();
    for (const t of [0, 500, 1000]) s = poke(s, t).state;
    let r = poke(s, 1500); s = r.state;
    expect(r.reaction).toBe("annoyed");
    expect(pose(s, 1600)).toBe("annoyed");
    expect(sulkLine(s, 1600)).toBe(SULK_LINES.annoyed);
    r = poke(s, 2000);
    expect(r.reaction).toBe("ignored");
    expect(r.state.annoyedUntil).toBe(1500 + ANNOYED_MS);
    // After it, the poke sulk started by the third poke is still running.
    expect(pose(s, 1500 + ANNOYED_MS + 1)).toBe("sulk");
  });

  it("names the next moment its pose changes by itself", () => {
    let s = initialSulk();
    for (const t of [0, 1, 2]) s = poke(s, t).state;
    expect(nextChange(s, 3)).toBe(2 + LOOK_BACK_MS);
    expect(nextChange(s, 2 + POKE_SULK_MS + 1)).toBeNull();
  });
});
