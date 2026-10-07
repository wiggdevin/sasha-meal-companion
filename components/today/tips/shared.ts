/**
 * What the tip tile and its full view share (2026-10-03). The view is a container transform out of
 * the tile and back (one layout id, as the explainer's pin and player share one), and both carry
 * the tile's corner radius as a style so Motion keeps the corners round while the box scales.
 */
export const TIP_LAYOUT_ID = "board-tip";

export const TIP_CORNER = { borderRadius: 16 } as const;

/** The attribute the board puts on the tile's open control, so focus can go back to it on close. */
export const TIP_OPEN_ATTR = "data-tip-open";
