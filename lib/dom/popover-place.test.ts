import { describe, expect, it } from "vitest";
import { placePopover } from "./popover-place";

// An iPhone-sized viewport, 390 x 844: the usable band runs from the safe top (47) to above the safe
// bottom (34) and the dock clearance (76), 47..734.
const BASE = { viewportWidth: 390, areaTop: 47, areaBottom: 734 };
const button = (top: number, height = 44, left = 100, width = 120) =>
  ({ top, bottom: top + height, left, right: left + width });

describe("placePopover", () => {
  it("sits below the trigger when the card fits there, centred with a 16 px gutter", () => {
    const place = placePopover({ ...BASE, trigger: button(120), cardHeight: 300 });
    expect(place.side).toBe("below");
    expect(place.top).toBe(120 + 44 + 8);
    expect(place.left).toBe(16);
    expect(place.width).toBe(390 - 32);
    expect(place.maxHeight).toBe(734 - 16 - (47 + 16));
    // Scales out of the trigger's centre, relative to the card.
    expect(place.originX).toBe(160 - 16);
    expect(place.originY).toBe(142 - 172);
  });

  it("caps the width at 480 px on a wide screen and keeps it centred", () => {
    const place = placePopover({ ...BASE, viewportWidth: 1024, trigger: button(120), cardHeight: 200 });
    expect(place.width).toBe(480);
    expect(place.left).toBe((1024 - 480) / 2);
  });

  it("flips above the trigger when there is no room below", () => {
    const place = placePopover({ ...BASE, trigger: button(600), cardHeight: 300 });
    expect(place.side).toBe("above");
    expect(place.top).toBe(600 - 8 - 300);
    expect(place.originY).toBe(622 - place.top);
    expect(place.originY).toBeGreaterThan(300);
  });

  it("takes the roomier side and clamps into the band when it fits on neither", () => {
    const place = placePopover({ ...BASE, trigger: button(380), cardHeight: 600 });
    expect(place.side).toBe("above");
    expect(place.top).toBeGreaterThanOrEqual(47 + 16);
    expect(place.top + Math.min(600, place.maxHeight)).toBeLessThanOrEqual(734 - 16);
  });

  it("never lets a tall card leave the usable band", () => {
    const place = placePopover({ ...BASE, trigger: button(100), cardHeight: 5000 });
    expect(place.top).toBe(47 + 16);
    expect(place.maxHeight).toBe(734 - 16 - 63);
  });

  it("centres the card when there is no trigger", () => {
    const place = placePopover({ ...BASE, trigger: null, cardHeight: 300 });
    expect(place.side).toBe("center");
    expect(place.top).toBe(63 + (place.maxHeight - 300) / 2);
    expect(place.originX).toBe(place.width / 2);
    expect(place.originY).toBe(150);
  });

  it("centres the card when the trigger has no size or is off screen", () => {
    expect(placePopover({ ...BASE, trigger: { top: 0, bottom: 0, left: 0, right: 0 }, cardHeight: 200 }).side)
      .toBe("center");
    expect(placePopover({ ...BASE, trigger: button(2000), cardHeight: 200 }).side).toBe("center");
  });

  it("keeps a chosen side while the card grows", () => {
    const first = placePopover({ ...BASE, trigger: button(300), cardHeight: 200 });
    expect(first.side).toBe("below");
    const grown = placePopover({ ...BASE, trigger: button(300), cardHeight: 500, side: first.side });
    expect(grown.side).toBe("below");
    expect(grown.top + 500).toBeLessThanOrEqual(734 - 16);
  });

  it("hangs an above card from its bottom edge, so growing content does not move that edge", () => {
    // An Add button at the bottom of a list (y 640 on an 844 px layer): the card opens above it.
    const first = placePopover({ ...BASE, trigger: button(640), cardHeight: 300, layerHeight: 844 });
    expect(first.side).toBe("above");
    expect(first.bottom).toBe(844 - (640 - 8));
    const grown = placePopover({ ...BASE, trigger: button(640), cardHeight: 420, layerHeight: 844,
      side: first.side });
    expect(grown.bottom).toBe(first.bottom);
    // Below the trigger, or with no layer height, the card is placed by its top as before.
    expect(placePopover({ ...BASE, trigger: button(120), cardHeight: 300, layerHeight: 844 }).bottom)
      .toBeUndefined();
    expect(placePopover({ ...BASE, trigger: button(640), cardHeight: 300 }).bottom).toBeUndefined();
  });

  it("keeps its side when the keyboard covers the trigger, clamped above the keyboard", () => {
    const opened = placePopover({ ...BASE, trigger: button(640), cardHeight: 300 });
    // The keyboard takes the bottom 336 px: the band now ends at 508, under the Add button's top.
    const typing = placePopover({ ...BASE, areaBottom: 508, trigger: button(640), cardHeight: 300,
      side: opened.side });
    expect(typing.side).toBe("above");
    expect(typing.top).toBe(508 - 16 - 300);
  });
});
