import FoodsTabs from "@/components/FoodsTabs";
import { APP_NAME } from "@/lib/brand";

/**
 * The Foods tab. Two halves behind one control — Eats, what you can eat; Avoids, what you
 * cannot — so no card reads twice (docs/plans/2026-09-16-foods-eats-avoids.md).
 *
 * Shell copied from Foods.dc.html: 40 px/300 title on the paper ground, 20 px between blocks.
 * The title row and the tablist live in FoodsTabs; this stays a server component for its
 * metadata.
 */
export const metadata = {
  title: `Foods — ${APP_NAME}`,
};

export default function FoodsPage() {
  return (
    <main
      className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
      style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}
    >
      <FoodsTabs />
    </main>
  );
}
