"use client";
/**
 * The card style system (UI makeover §3, DESIGN.md §Elevation, the contrast step): every CardFrame
 * size, the three levels nested the way the app nests them, the four tones (the ink hero card and
 * its own step down), and the display numerals, on the real ground. Static, no network and no
 * device store.
 */
import { useState } from "react";
import CardFrame from "@/components/ui/CardFrame";
import Button from "@/components/ui/Button";

export default function CardsGallery() {
  const [taps, setTaps] = useState(0);
  return (
    <section className="flex flex-col gap-3" aria-label="Cards">
      <h2 className="section-title m-0 px-1 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm">Cards</h2>
      <p className="m-0 px-1 text-caption text-muted">CardFrame sizes, levels and tones. Each step differs from the one behind it.</p>

      <CardFrame size="sm" title="Small" meta="12 px padding, 16 px radius">
        <p className="m-0 text-caption text-graphite">A compact row card.</p>
      </CardFrame>
      <CardFrame size="md" title="Medium" meta="16 px padding, 24 px radius" aside={<span className="text-caption tabular-nums">3</span>}>
        <p className="m-0 text-caption text-graphite">The default card.</p>
      </CardFrame>
      <CardFrame size="lg" title="Large" meta="20 px padding, 32 px radius"
        footer={<Button variant="secondary" size="sm">Edit</Button>}>
        <p className="m-0 text-caption text-graphite">A page-level card with a footer action.</p>
      </CardFrame>

      <CardFrame size="lg" title="Raised" meta="On the ground: E1, the card shadow">
        <CardFrame size="md" title="Inset" meta="Inside a card: one shade down, a hairline, no shadow">
          <CardFrame size="sm" title="Card again" meta="Inside the inset: the card face, no shadow">
            <p className="m-0 text-caption text-graphite">No fourth level.</p>
          </CardFrame>
        </CardFrame>
      </CardFrame>

      <CardFrame size="md" tone="olive" title="Olive" meta="A call to action">
        <p className="m-0 text-caption">Primary fill with cream text.</p>
      </CardFrame>
      <CardFrame size="md" tone="recess" title="Recess" meta="The inset face, standing alone" />

      <CardFrame size="lg" tone="ink" title="Ink" meta="The hero card: charcoal, cream text">
        <p className="m-0 flex items-baseline gap-2">
          <span className="numeral text-numeral-xl kcal">1,240</span>
          <span className="text-caption text-muted">kcal left</span>
        </p>
        <CardFrame size="sm" title="Ink inset" meta="Inside an ink card: one step down into the charcoal">
          <p className="m-0 flex items-baseline gap-2">
            <span className="numeral text-numeral-md text-charcoal">96 g</span>
            <span className="text-caption text-muted">protein left</span>
          </p>
        </CardFrame>
      </CardFrame>
      <CardFrame size="md" title="Numerals" meta="text-numeral-xl, lg and md, with .numeral">
        <div className="flex items-baseline gap-4">
          <span className="numeral text-numeral-xl kcal">1,860</span>
          <span className="numeral text-numeral-lg text-charcoal">7</span>
          <span className="numeral text-numeral-md text-graphite">64 oz</span>
        </div>
      </CardFrame>
      <CardFrame size="sm" title="Whole card is a button" meta={`Taps: ${taps}`}
        onClick={() => setTaps((n) => n + 1)} />
    </section>
  );
}
